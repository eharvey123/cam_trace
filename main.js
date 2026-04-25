import { Tracker } from './tracker.js';
import { Renderer } from './renderer.js';

async function main() {
    const statusText = document.getElementById('status-text');
    const startBtn = document.getElementById('start-btn');
    const canvas = document.getElementById('webgpu-canvas');
    const metricX = document.getElementById('metric-x');
    const metricY = document.getElementById('metric-y');
    const metricZ = document.getElementById('metric-z');
    const modeBtn = document.getElementById('mode-btn');


    // Initialize WebGPU Renderer
    const renderer = new Renderer(canvas);
    try {
        statusText.innerText = "Initializing WebGPU...";
        await renderer.initialize();
    } catch (e) {
        statusText.innerText = e.message;
        statusText.style.color = "var(--error, #ef4444)";
        return;
    }

    // Initialize Tracker
    statusText.innerText = "Loading MediaPipe Model...";
    const tracker = new Tracker(
        document.getElementById('webcam'),
        document.getElementById('debug-canvas'),
        (lightPos) => {
            renderer.setLightPos(lightPos);
            // Update UI
            metricX.innerText = lightPos.x.toFixed(2);
            metricY.innerText = lightPos.y.toFixed(2);
            metricZ.innerText = lightPos.z.toFixed(2);
        }
    );

    try {
        await tracker.initialize();
        statusText.innerText = "Ready! Click Start Camera.";
        startBtn.disabled = false;
    } catch (e) {
        statusText.innerText = "Failed to load tracker model.";
        return;
    }

    startBtn.addEventListener('click', async () => {
        try {
            startBtn.disabled = true;
            statusText.innerText = "Starting camera...";
            await tracker.startCamera();
            statusText.innerText = "Tracking active.";
            startBtn.style.display = 'none'; // hide button once started
        } catch (e) {
            statusText.innerText = "Camera access denied or failed.";
            startBtn.disabled = false;
        }
    });

    modeBtn.addEventListener('click', () => {
        renderer.usePathTracing = !renderer.usePathTracing;
        if (renderer.usePathTracing) {
            modeBtn.innerText = "Switch to Ray Tracing";
            modeBtn.style.backgroundColor = "#8b5cf6"; // Purple
        } else {
            modeBtn.innerText = "Switch to Path Tracing";
            modeBtn.style.backgroundColor = "#f59e0b"; // Orange
        }
        renderer.resetAccumulation();
    });

    // Start render loop
    function renderLoop() {
        renderer.render();
        requestAnimationFrame(renderLoop);
    }

    renderLoop();
}

// Start app
window.addEventListener('load', main);
