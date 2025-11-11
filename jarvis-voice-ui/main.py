"""
JARVIS Voice Interface

Voice-controlled interface for JARVIS with speech-to-text and text-to-speech.
"""

import logging
import os
from pathlib import Path
from typing import Optional

import httpx
import uvicorn
from fastapi import FastAPI, File, UploadFile, HTTPException
from fastapi.responses import HTMLResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from openai import OpenAI
from pydantic import BaseModel

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s"
)
logger = logging.getLogger(__name__)

# Initialize FastAPI
app = FastAPI(title="JARVIS Voice Interface")

# OpenAI client
openai_client = None

# JARVIS brain URL
JARVIS_URL = os.getenv("JARVIS_URL", "http://localhost:8055")
ARCHON_DASHBOARD_URL = os.getenv("ARCHON_DASHBOARD_URL", "http://localhost:3737")


@app.on_event("startup")
async def startup():
    """Initialize OpenAI client on startup."""
    global openai_client
    api_key = os.getenv("OPENAI_API_KEY")
    if api_key:
        openai_client = OpenAI(api_key=api_key)
        logger.info("OpenAI client initialized")
    else:
        logger.warning("No OPENAI_API_KEY found - voice features will be limited")


@app.get("/", response_class=HTMLResponse)
async def jarvis_interface():
    """
    JARVIS voice interface - Main UI.

    Provides a sleek, Iron Man-inspired interface for voice interaction with JARVIS.
    """
    html_content = """
    <!DOCTYPE html>
    <html>
    <head>
        <title>JARVIS - Voice Interface</title>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <style>
            * {
                margin: 0;
                padding: 0;
                box-sizing: border-box;
            }

            body {
                background: linear-gradient(135deg, #000000 0%, #0a0e27 50%, #000000 100%);
                color: #00d9ff;
                font-family: 'Segoe UI', 'Roboto', 'Helvetica Neue', Arial, sans-serif;
                overflow: hidden;
                height: 100vh;
            }

            .header {
                position: absolute;
                top: 20px;
                left: 0;
                right: 0;
                display: flex;
                justify-content: space-between;
                align-items: center;
                padding: 0 40px;
                z-index: 100;
            }

            .logo {
                font-size: 2em;
                font-weight: bold;
                text-shadow: 0 0 20px #00d9ff;
                letter-spacing: 8px;
            }

            .dashboard-link {
                background: rgba(0, 217, 255, 0.2);
                color: #00d9ff;
                text-decoration: none;
                padding: 12px 24px;
                border-radius: 8px;
                border: 1px solid #00d9ff;
                transition: all 0.3s;
                font-size: 0.9em;
            }

            .dashboard-link:hover {
                background: rgba(0, 217, 255, 0.4);
                box-shadow: 0 0 20px rgba(0, 217, 255, 0.5);
            }

            .jarvis-container {
                width: 100vw;
                height: 100vh;
                display: flex;
                flex-direction: column;
                align-items: center;
                justify-content: center;
                position: relative;
            }

            .jarvis-circle {
                width: 350px;
                height: 350px;
                border-radius: 50%;
                border: 3px solid #00d9ff;
                background: radial-gradient(circle, rgba(0,217,255,0.3) 0%, rgba(0,0,0,0) 70%);
                display: flex;
                align-items: center;
                justify-content: center;
                position: relative;
                box-shadow: 0 0 60px rgba(0, 217, 255, 0.6),
                            inset 0 0 60px rgba(0, 217, 255, 0.2);
                animation: idle-pulse 3s infinite;
                cursor: pointer;
                transition: all 0.3s;
            }

            .jarvis-circle:hover {
                transform: scale(1.05);
                box-shadow: 0 0 80px rgba(0, 217, 255, 0.8),
                            inset 0 0 80px rgba(0, 217, 255, 0.3);
            }

            @keyframes idle-pulse {
                0%, 100% {
                    box-shadow: 0 0 60px rgba(0, 217, 255, 0.6),
                                inset 0 0 60px rgba(0, 217, 255, 0.2);
                }
                50% {
                    box-shadow: 0 0 90px rgba(0, 217, 255, 0.8),
                                inset 0 0 80px rgba(0, 217, 255, 0.3);
                }
            }

            .jarvis-circle.listening {
                border-color: #ff0055;
                box-shadow: 0 0 100px rgba(255, 0, 85, 0.9),
                            inset 0 0 100px rgba(255, 0, 85, 0.4);
                animation: listening-pulse 0.8s infinite;
            }

            @keyframes listening-pulse {
                0%, 100% {
                    transform: scale(1);
                    opacity: 1;
                }
                50% {
                    transform: scale(1.08);
                    opacity: 0.9;
                }
            }

            .jarvis-circle.processing {
                border-color: #ffaa00;
                animation: processing-spin 2s linear infinite;
            }

            @keyframes processing-spin {
                from { transform: rotate(0deg); }
                to { transform: rotate(360deg); }
            }

            .jarvis-text {
                font-size: 4em;
                text-shadow: 0 0 30px #00d9ff;
                letter-spacing: 12px;
                font-weight: 300;
            }

            .status-text {
                margin-top: 40px;
                font-size: 1.3em;
                text-align: center;
                text-shadow: 0 0 10px #00d9ff;
                min-height: 30px;
            }

            .response-box {
                position: absolute;
                bottom: 60px;
                left: 60px;
                right: 60px;
                background: rgba(0, 217, 255, 0.05);
                border: 1px solid rgba(0, 217, 255, 0.3);
                border-radius: 12px;
                padding: 24px;
                max-height: 250px;
                overflow-y: auto;
                backdrop-filter: blur(10px);
                box-shadow: 0 4px 30px rgba(0, 217, 255, 0.2);
                display: none;
            }

            .response-box.visible {
                display: block;
                animation: slideUp 0.5s ease-out;
            }

            @keyframes slideUp {
                from {
                    opacity: 0;
                    transform: translateY(20px);
                }
                to {
                    opacity: 1;
                    transform: translateY(0);
                }
            }

            .response-content {
                line-height: 1.6;
                color: #00d9ff;
            }

            .response-metadata {
                margin-top: 16px;
                padding-top: 16px;
                border-top: 1px solid rgba(0, 217, 255, 0.2);
                font-size: 0.85em;
                color: rgba(0, 217, 255, 0.7);
            }

            .arc {
                position: absolute;
                width: 100%;
                height: 100%;
                border-radius: 50%;
                border: 2px solid transparent;
                border-top-color: rgba(0, 217, 255, 0.6);
                animation: rotate 4s linear infinite;
            }

            .arc:nth-child(2) {
                animation-duration: 3s;
                animation-direction: reverse;
                border-top-color: rgba(0, 217, 255, 0.4);
            }

            .arc:nth-child(3) {
                animation-duration: 5s;
                border-top-color: rgba(0, 217, 255, 0.2);
            }

            @keyframes rotate {
                to { transform: rotate(360deg); }
            }

            .instructions {
                position: absolute;
                bottom: 20px;
                left: 50%;
                transform: translateX(-50%);
                font-size: 0.85em;
                color: rgba(0, 217, 255, 0.5);
                text-align: center;
            }

            /* Scrollbar styling */
            .response-box::-webkit-scrollbar {
                width: 8px;
            }

            .response-box::-webkit-scrollbar-track {
                background: rgba(0, 217, 255, 0.05);
                border-radius: 4px;
            }

            .response-box::-webkit-scrollbar-thumb {
                background: rgba(0, 217, 255, 0.3);
                border-radius: 4px;
            }

            .response-box::-webkit-scrollbar-thumb:hover {
                background: rgba(0, 217, 255, 0.5);
            }
        </style>
    </head>
    <body>
        <div class="header">
            <div class="logo">JARVIS</div>
            <a href="ARCHON_DASHBOARD_URL_PLACEHOLDER" target="_blank" class="dashboard-link">
                📊 Control Center
            </a>
        </div>

        <div class="jarvis-container">
            <div id="jarvisCircle" class="jarvis-circle">
                <div class="arc"></div>
                <div class="arc"></div>
                <div class="arc"></div>
                <div class="jarvis-text">J.A.R.V.I.S.</div>
            </div>
            <div class="status-text" id="status">
                Click to speak or say "JARVIS" to activate
            </div>
            <div class="response-box" id="response"></div>
        </div>

        <div class="instructions">
            Press and hold the circle to speak, or use wake word "JARVIS"
        </div>

        <script>
            const jarvisCircle = document.getElementById('jarvisCircle');
            const statusText = document.getElementById('status');
            const responseBox = document.getElementById('response');
            let mediaRecorder;
            let audioChunks = [];
            let isRecording = false;

            // Mouse/touch controls for recording
            jarvisCircle.addEventListener('mousedown', startRecording);
            jarvisCircle.addEventListener('mouseup', stopRecording);
            jarvisCircle.addEventListener('touchstart', startRecording);
            jarvisCircle.addEventListener('touchend', stopRecording);

            async function startRecording(e) {
                e.preventDefault();
                if (isRecording) return;

                jarvisCircle.classList.add('listening');
                jarvisCircle.classList.remove('processing');
                statusText.textContent = 'Listening...';
                responseBox.classList.remove('visible');
                audioChunks = [];
                isRecording = true;

                try {
                    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
                    mediaRecorder = new MediaRecorder(stream);

                    mediaRecorder.ondataavailable = (event) => {
                        audioChunks.push(event.data);
                    };

                    mediaRecorder.start();
                } catch (error) {
                    console.error('Error accessing microphone:', error);
                    statusText.textContent = 'Error: Could not access microphone';
                    jarvisCircle.classList.remove('listening');
                    isRecording = false;
                }
            }

            async function stopRecording(e) {
                e.preventDefault();
                if (!isRecording) return;

                isRecording = false;
                jarvisCircle.classList.remove('listening');
                jarvisCircle.classList.add('processing');
                statusText.textContent = 'Processing...';

                mediaRecorder.stop();

                mediaRecorder.onstop = async () => {
                    const audioBlob = new Blob(audioChunks, { type: 'audio/webm' });
                    const formData = new FormData();
                    formData.append('audio', audioBlob);

                    try {
                        // Step 1: Transcribe audio
                        const transcribeRes = await fetch('/api/transcribe', {
                            method: 'POST',
                            body: formData
                        });

                        if (!transcribeRes.ok) {
                            throw new Error('Transcription failed');
                        }

                        const { text } = await transcribeRes.json();
                        statusText.textContent = `"${text}"`;

                        // Step 2: Send to JARVIS brain
                        const processRes = await fetch('/api/process', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ text })
                        });

                        if (!processRes.ok) {
                            throw new Error('Processing failed');
                        }

                        const result = await processRes.json();

                        // Step 3: Display response
                        displayResponse(text, result);

                        // Step 4: Synthesize and play audio
                        const audioRes = await fetch('/api/synthesize', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ text: result.response })
                        });

                        if (audioRes.ok) {
                            const audioUrl = URL.createObjectURL(await audioRes.blob());
                            const audio = new Audio(audioUrl);
                            audio.play();
                        }

                        jarvisCircle.classList.remove('processing');
                        statusText.textContent = 'Ready';

                    } catch (error) {
                        console.error('Error:', error);
                        statusText.textContent = `Error: ${error.message}`;
                        jarvisCircle.classList.remove('processing');

                        responseBox.innerHTML = `
                            <div class="response-content" style="color: #ff0055;">
                                Error: ${error.message}
                            </div>
                        `;
                        responseBox.classList.add('visible');
                    }
                };
            }

            function displayResponse(userText, result) {
                const metadata = [];
                if (result.intent) {
                    metadata.push(`Intent: ${result.intent}`);
                }
                if (result.confidence) {
                    metadata.push(`Confidence: ${(result.confidence * 100).toFixed(0)}%`);
                }

                responseBox.innerHTML = `
                    <div class="response-content">
                        <strong>You:</strong> ${userText}<br><br>
                        <strong>JARVIS:</strong> ${result.response}
                    </div>
                    ${metadata.length > 0 ? `
                        <div class="response-metadata">
                            ${metadata.join(' • ')}
                        </div>
                    ` : ''}
                `;
                responseBox.classList.add('visible');

                // Auto-hide after 30 seconds
                setTimeout(() => {
                    responseBox.classList.remove('visible');
                }, 30000);
            }

            // Hide response on click anywhere
            document.addEventListener('click', (e) => {
                if (!responseBox.contains(e.target) && e.target !== jarvisCircle) {
                    responseBox.classList.remove('visible');
                }
            });
        </script>
    </body>
    </html>
    """.replace('ARCHON_DASHBOARD_URL_PLACEHOLDER', ARCHON_DASHBOARD_URL)

    return HTMLResponse(content=html_content)


class TranscribeRequest(BaseModel):
    """Request model for transcription."""
    pass  # Audio comes as file upload


class ProcessRequest(BaseModel):
    """Request model for text processing."""
    text: str


class SynthesizeRequest(BaseModel):
    """Request model for speech synthesis."""
    text: str


@app.post("/api/transcribe")
async def transcribe_audio(audio: UploadFile = File(...)):
    """
    Transcribe audio to text using OpenAI Whisper.
    """
    if not openai_client:
        raise HTTPException(status_code=503, detail="OpenAI client not initialized")

    try:
        # Save uploaded file temporarily
        temp_path = f"/tmp/{audio.filename}"
        with open(temp_path, "wb") as f:
            content = await audio.read()
            f.write(content)

        # Transcribe with Whisper
        with open(temp_path, "rb") as audio_file:
            transcript = openai_client.audio.transcriptions.create(
                model="whisper-1",
                file=audio_file,
                language="en"
            )

        # Clean up
        Path(temp_path).unlink()

        logger.info(f"Transcribed: {transcript.text}")
        return {"text": transcript.text}

    except Exception as e:
        logger.error(f"Transcription error: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/process")
async def process_command(request: ProcessRequest):
    """
    Process text command through JARVIS brain.
    """
    try:
        async with httpx.AsyncClient(timeout=60.0) as client:
            response = await client.post(
                f"{JARVIS_URL}/api/process",
                json={"text": request.text}
            )

            if response.status_code == 200:
                return response.json()
            else:
                raise HTTPException(
                    status_code=response.status_code,
                    detail=f"JARVIS brain error: {response.text}"
                )

    except httpx.ConnectError:
        raise HTTPException(
            status_code=503,
            detail="Cannot connect to JARVIS brain. Is the service running?"
        )
    except Exception as e:
        logger.error(f"Processing error: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/synthesize")
async def synthesize_speech(request: SynthesizeRequest):
    """
    Convert text to speech using OpenAI TTS.
    """
    if not openai_client:
        raise HTTPException(status_code=503, detail="OpenAI client not initialized")

    try:
        response = openai_client.audio.speech.create(
            model="tts-1",
            voice="onyx",  # Deep, professional voice (closest to JARVIS)
            input=request.text,
            speed=1.0
        )

        # Stream the audio response
        return StreamingResponse(
            response.iter_bytes(),
            media_type="audio/mpeg"
        )

    except Exception as e:
        logger.error(f"Synthesis error: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/health")
async def health_check():
    """Health check endpoint."""
    return {
        "status": "healthy",
        "service": "jarvis-voice-ui",
        "openai_available": openai_client is not None,
        "jarvis_url": JARVIS_URL
    }


if __name__ == "__main__":
    port = int(os.getenv("JARVIS_VOICE_PORT", "3738"))
    uvicorn.run(app, host="0.0.0.0", port=port)
