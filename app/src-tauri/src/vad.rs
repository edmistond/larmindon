use ndarray::{s, Array1, Array2, ArrayD, IxDyn};
use ort::session::Session;
use ort::value::Tensor;
use std::path::Path;

const VAD_SAMPLE_RATE: u32 = 16_000;
const VAD_CHUNK_SIZE: usize = 512;
const VAD_CONTEXT_SIZE: usize = 64;

/// Default pre-speech ring buffer: 500ms at 16kHz.
const DEFAULT_PRE_SPEECH_SAMPLES: usize = 8000;

// ---------------------------------------------------------------------------
// Silero VAD model wrapper (v5, opset 16)
// ---------------------------------------------------------------------------

struct SileroModel {
    session: Session,
    state: ArrayD<f32>,
    context: Array2<f32>,
}

impl SileroModel {
    fn new(model_path: &Path) -> Result<Self, Box<dyn std::error::Error>> {
        let session = Session::builder()?
            .with_intra_threads(1)?
            .with_inter_threads(1)?
            .commit_from_file(model_path)?;

        Ok(Self {
            session,
            state: ArrayD::<f32>::zeros(IxDyn(&[2, 1, 128])),
            context: Array2::<f32>::zeros((1, VAD_CONTEXT_SIZE)),
        })
    }

    fn reset(&mut self) {
        self.state = ArrayD::<f32>::zeros(IxDyn(&[2, 1, 128]));
        self.context = Array2::<f32>::zeros((1, VAD_CONTEXT_SIZE));
    }

    /// Feed a 512-sample frame and return the speech probability [0.0, 1.0].
    fn process_frame(&mut self, frame: &[f32]) -> Result<f32, Box<dyn std::error::Error>> {
        assert_eq!(frame.len(), VAD_CHUNK_SIZE);

        // Build input: [1, context_size + chunk_size]
        let total_len = VAD_CONTEXT_SIZE + VAD_CHUNK_SIZE;
        let mut input = Array2::<f32>::zeros((1, total_len));
        input
            .slice_mut(s![.., 0..VAD_CONTEXT_SIZE])
            .assign(&self.context);
        for (j, &sample) in frame.iter().enumerate() {
            input[[0, VAD_CONTEXT_SIZE + j]] = sample;
        }

        let sr_array = Array1::<i64>::from_elem(1, VAD_SAMPLE_RATE as i64);

        let input_tensor = Tensor::from_array(input.clone())?;
        let state_tensor = Tensor::from_array(self.state.clone())?;
        let sr_tensor = Tensor::from_array(sr_array)?;

        let inputs = ort::inputs![input_tensor, state_tensor, sr_tensor];
        let outputs = self.session.run(inputs)?;

        // Update state
        let state_key = if outputs.contains_key("stateN") {
            "stateN"
        } else {
            "state"
        };
        let (state_shape, state_data) = outputs[state_key].try_extract_tensor::<f32>()?;
        let shape_usize: Vec<usize> = state_shape.iter().map(|&d| d as usize).collect();
        self.state =
            ArrayD::<f32>::from_shape_vec(IxDyn(&shape_usize), state_data.to_vec())?;

        // Update context: last 64 samples of the input chunk
        let new_ctx: Vec<f32> = frame[VAD_CHUNK_SIZE - VAD_CONTEXT_SIZE..].to_vec();
        self.context = Array2::from_shape_vec((1, VAD_CONTEXT_SIZE), new_ctx)?;

        // Extract speech probability
        let output_key = if outputs.contains_key("output") {
            "output"
        } else {
            outputs
                .iter()
                .next()
                .map(|(name, _)| name)
                .unwrap_or("output")
        };
        let (_shape, output_data) = outputs[output_key].try_extract_tensor::<f32>()?;
        Ok(output_data[0])
    }
}

// ---------------------------------------------------------------------------
// Pre-speech ring buffer
// ---------------------------------------------------------------------------

pub struct PreSpeechRingBuffer {
    data: Vec<f32>,
    capacity: usize,
    write_pos: usize,
    len: usize,
}

impl PreSpeechRingBuffer {
    pub fn new(capacity: usize) -> Self {
        Self {
            data: vec![0.0; capacity],
            capacity,
            write_pos: 0,
            len: 0,
        }
    }

    pub fn push_slice(&mut self, samples: &[f32]) {
        for &s in samples {
            self.data[self.write_pos] = s;
            self.write_pos = (self.write_pos + 1) % self.capacity;
        }
        self.len = (self.len + samples.len()).min(self.capacity);
    }

    /// Drain all buffered samples in chronological order, reset the buffer.
    pub fn drain_all(&mut self) -> Vec<f32> {
        if self.len == 0 {
            return Vec::new();
        }
        let mut out = Vec::with_capacity(self.len);
        let start = if self.len < self.capacity {
            0
        } else {
            self.write_pos
        };
        for i in 0..self.len {
            out.push(self.data[(start + i) % self.capacity]);
        }
        self.len = 0;
        self.write_pos = 0;
        out
    }

    pub fn len(&self) -> usize {
        self.len
    }
}

// ---------------------------------------------------------------------------
// VAD state machine
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VadState {
    Silence,
    Speech,
}

#[derive(Debug)]
pub enum VadDecision {
    /// Frame is silence; was buffered in ring buffer.
    Silence,
    /// Speech just started; ring buffer has been drained into `pre_speech_samples`.
    SpeechStarted {
        pre_speech_samples: Vec<f32>,
    },
    /// Speech continues; frame should be appended to ASR buffer.
    SpeechContinues,
    /// Speech just ended; frame should be appended, then flush + reset.
    SpeechEnded,
}

pub struct VadProcessor {
    model: SileroModel,
    ring_buffer: PreSpeechRingBuffer,
    state: VadState,
    threshold: f32,
    min_silence_frames: u32,
    min_speech_frames: u32,
    speech_frame_count: u32,
    silence_frame_count: u32,
}

impl VadProcessor {
    pub fn new(
        model_path: &Path,
        threshold: f32,
        min_silence_duration_ms: u32,
        min_speech_duration_ms: u32,
        pre_speech_ms: usize,
    ) -> Result<Self, Box<dyn std::error::Error>> {
        let model = SileroModel::new(model_path)?;
        let pre_speech_samples = VAD_SAMPLE_RATE as usize * pre_speech_ms / 1000;
        let frame_ms = (VAD_CHUNK_SIZE as f32 / VAD_SAMPLE_RATE as f32 * 1000.0) as u32; // 32ms

        Ok(Self {
            model,
            ring_buffer: PreSpeechRingBuffer::new(pre_speech_samples),
            state: VadState::Silence,
            threshold,
            min_silence_frames: min_silence_duration_ms / frame_ms,
            min_speech_frames: min_speech_duration_ms / frame_ms,
            speech_frame_count: 0,
            silence_frame_count: 0,
        })
    }

    pub fn state(&self) -> VadState {
        self.state
    }

    pub fn pre_speech_buffer_len(&self) -> usize {
        self.ring_buffer.len()
    }

    /// Process a single 512-sample frame. Returns the decision and the speech probability.
    pub fn process_frame(
        &mut self,
        frame: &[f32],
    ) -> Result<(VadDecision, f32), Box<dyn std::error::Error>> {
        let prob = self.model.process_frame(frame)?;
        let is_speech = prob >= self.threshold;

        let decision = match self.state {
            VadState::Silence => {
                if is_speech {
                    self.speech_frame_count += 1;
                    self.silence_frame_count = 0;

                    if self.speech_frame_count >= self.min_speech_frames {
                        self.state = VadState::Speech;
                        let pre_speech = self.ring_buffer.drain_all();
                        VadDecision::SpeechStarted {
                            pre_speech_samples: pre_speech,
                        }
                    } else {
                        // Not enough consecutive speech frames yet; buffer it
                        self.ring_buffer.push_slice(frame);
                        VadDecision::Silence
                    }
                } else {
                    self.speech_frame_count = 0;
                    self.silence_frame_count += 1;
                    self.ring_buffer.push_slice(frame);
                    VadDecision::Silence
                }
            }
            VadState::Speech => {
                if is_speech {
                    self.speech_frame_count += 1;
                    self.silence_frame_count = 0;
                    VadDecision::SpeechContinues
                } else {
                    self.silence_frame_count += 1;
                    self.speech_frame_count = 0;

                    if self.silence_frame_count >= self.min_silence_frames {
                        self.state = VadState::Silence;
                        self.model.reset();
                        VadDecision::SpeechEnded
                    } else {
                        // Brief pause; keep treating as speech
                        VadDecision::SpeechContinues
                    }
                }
            }
        };

        Ok((decision, prob))
    }

    /// Reset the VAD to silence state (e.g., after a mid-speech Nemotron reset).
    pub fn reset_to_silence(&mut self) {
        self.state = VadState::Silence;
        self.speech_frame_count = 0;
        self.silence_frame_count = 0;
        self.model.reset();
    }
}
