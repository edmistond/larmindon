import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import "./App.css";

interface AudioDevice {
  id: string;
  name: string;
}

function App() {
  const [devices, setDevices] = useState<AudioDevice[]>([]);
  const [selectedDevice, setSelectedDevice] = useState<string>("");
  const [isRunning, setIsRunning] = useState(false);
  const [transcript, setTranscript] = useState("");
  const [error, setError] = useState("");
  const transcriptRef = useRef<HTMLDivElement>(null);

  async function refreshDevices() {
    const devs = await invoke<AudioDevice[]>("list_devices");
    setDevices(devs);
    setSelectedDevice((prev) => {
      if (prev && devs.some((d) => d.id === prev)) {
        return prev;
      }
      return devs.length > 0 ? devs[0].id : "";
    });
  }

  useEffect(() => {
    refreshDevices();

    const unlistenTranscription = listen<{ text: string }>(
      "transcription",
      (event) => {
        setTranscript((prev) => prev + event.payload.text);
        setError("");
      }
    );

    const unlistenError = listen<{ text: string }>(
      "transcription-error",
      (event) => {
        setError(event.payload.text);
        setIsRunning(false);
      }
    );

    return () => {
      unlistenTranscription.then((fn) => fn());
      unlistenError.then((fn) => fn());
    };
  }, []);

  useEffect(() => {
    if (transcriptRef.current) {
      transcriptRef.current.scrollTop = transcriptRef.current.scrollHeight;
    }
  }, [transcript]);

  async function handleStart() {
    setError("");
    try {
      await invoke("start_transcription", {
        deviceId: selectedDevice || null,
      });
      setIsRunning(true);
    } catch (e) {
      setError(String(e));
    }
  }

  async function handleStop() {
    try {
      await invoke("stop_transcription");
      setIsRunning(false);
    } catch (e) {
      setError(String(e));
    }
  }

  return (
    <main className="container">
      <div className="controls">
        <select
          value={selectedDevice}
          onChange={(e) => setSelectedDevice(e.target.value)}
          disabled={isRunning}
        >
          {devices.length === 0 && <option value="">No devices found</option>}
          {devices.map((dev) => (
            <option key={dev.id} value={dev.id}>
              {dev.name}
            </option>
          ))}
        </select>

        <button
          className="refresh-btn"
          onClick={refreshDevices}
          disabled={isRunning}
          title="Refresh device list"
        >
          &#x21bb;
        </button>

        {isRunning ? (
          <button className="stop-btn" onClick={handleStop}>
            Stop
          </button>
        ) : (
          <button
            className="start-btn"
            onClick={handleStart}
            disabled={devices.length === 0}
          >
            Start
          </button>
        )}
      </div>

      {error && <p className="error">{error}</p>}

      <div className="transcript" ref={transcriptRef}>
        {transcript || (
          <span className="placeholder">
            {isRunning
              ? "Listening..."
              : "Select an audio source and press Start"}
          </span>
        )}
      </div>
    </main>
  );
}

export default App;
