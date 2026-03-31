#[cfg(feature = "cpal")]
use cpal::traits::DeviceTrait;
#[cfg(feature = "cpal")]
use cpal::{Device, SampleFormat, SupportedStreamConfig};

const PREFERRED_RATES: [u32; 3] = [16000, 44100, 48000];
const MAX_RATE: u32 = 48000;

#[cfg(feature = "cpal")]
pub fn select_input_config(
    device: &Device,
) -> Result<(SupportedStreamConfig, SampleFormat), Box<dyn std::error::Error>> {
    let configs: Vec<_> = device.supported_input_configs()?.collect();

    // On Windows, an output device used for WASAPI loopback won't have input
    // configs — fall back to its output configs so we pick a valid format.
    #[cfg(target_os = "windows")]
    let configs: Vec<_> = if configs.is_empty() {
        device.supported_output_configs()?.collect()
    } else {
        configs
    };

    for &rate in &PREFERRED_RATES {
        for range in &configs {
            if let Some(config) = range.clone().try_with_sample_rate(rate) {
                let fmt = config.sample_format();
                return Ok((config, fmt));
            }
        }
    }

    // Fallback: use first config, capped at MAX_RATE
    let range = configs
        .into_iter()
        .next()
        .ok_or("No supported input configs found")?;

    let capped_rate = range.max_sample_rate().min(MAX_RATE);
    let config = range.with_sample_rate(capped_rate);
    let fmt = config.sample_format();
    Ok((config, fmt))
}

#[cfg(not(feature = "cpal"))]
pub fn select_input_config(_device: &()) -> Result<((), ()), Box<dyn std::error::Error>> {
    Err("CPAL feature not enabled".into())
}
