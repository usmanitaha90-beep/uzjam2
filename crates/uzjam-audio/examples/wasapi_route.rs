#[cfg(windows)]
fn main() -> Result<(), Box<dyn std::error::Error>> {
    use std::time::Duration;
    use uzjam_audio::{AudioBackend, AudioRoute, AudioSourceKind, StreamConfig, WasapiBackend};

    let mut arguments = std::env::args().skip(1);
    let source_device_id = arguments
        .next()
        .ok_or("usage: wasapi_route <loopback-source-id> <output-device-id> [seconds]")?;
    let output_device_id = arguments
        .next()
        .ok_or("usage: wasapi_route <loopback-source-id> <output-device-id> [seconds]")?;
    let seconds = arguments
        .next()
        .map(|value| value.parse::<u64>())
        .transpose()?
        .unwrap_or(10);

    let backend = WasapiBackend::new();
    let route = AudioRoute {
        source_device_id,
        source_kind: AudioSourceKind::SystemLoopback,
        output_device_id,
    };
    let processor = |_samples: &mut [f32], _channels: u16| {};
    let mut stream =
        backend.open_processing_stream(route, StreamConfig::default(), Box::new(processor))?;
    stream.start()?;
    println!("WASAPI route is running for {seconds} seconds...");
    std::thread::sleep(Duration::from_secs(seconds));
    stream.stop()?;
    println!("Telemetry: {:#?}", stream.telemetry());
    Ok(())
}

#[cfg(not(windows))]
fn main() {
    eprintln!("The WASAPI route diagnostic is available on Windows only.");
}
