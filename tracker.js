import { FaceLandmarker, FilesetResolver } from "https://cdn.skypack.dev/@mediapipe/tasks-vision@0.10.3";

export class Tracker {
    constructor(videoElement, debugCanvasElement, onLightUpdate) {
        this.video = videoElement;
        this.canvas = debugCanvasElement;
        this.ctx = this.canvas.getContext('2d');
        this.onLightUpdate = onLightUpdate;
        
        this.faceLandmarker = null;
        this.isRunning = false;
        this.lastVideoTime = -1;
        
        // Smoothed light position
        this.lightPos = { x: 0, y: 1.0, z: -0.5 };
        this.baseline = null;
        this.baseCenter = { x: 0.0, y: 1.0, z: -0.5 };
    }

    async initialize() {
        const vision = await FilesetResolver.forVisionTasks(
            "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.3/wasm"
        );
        
        this.faceLandmarker = await FaceLandmarker.createFromOptions(vision, {
            baseOptions: {
                modelAssetPath: `https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task`,
                delegate: "GPU"
            },
            outputFaceBlendshapes: false,
            runningMode: "VIDEO",
            numFaces: 1
        });
    }

    async startCamera() {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({
                video: { width: 640, height: 480, facingMode: "user" }
            });
            this.video.srcObject = stream;
            
            return new Promise((resolve) => {
                this.video.onloadeddata = () => {
                    this.canvas.width = this.video.videoWidth;
                    this.canvas.height = this.video.videoHeight;
                    this.isRunning = true;
                    this.renderLoop();
                    resolve();
                };
            });
        } catch (error) {
            console.error("Error accessing webcam:", error);
            throw error;
        }
    }

    renderLoop() {
        if (!this.isRunning) return;

        let startTimeMs = performance.now();
        if (this.lastVideoTime !== this.video.currentTime) {
            this.lastVideoTime = this.video.currentTime;
            
            const results = this.faceLandmarker.detectForVideo(this.video, startTimeMs);
            
            this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
            
            if (results.faceLandmarks && results.faceLandmarks.length > 0) {
                const landmarks = results.faceLandmarks[0];
                
                // Left eye indices roughly around 159, right eye roughly 386 in MediaPipe FaceMesh
                const leftEye = landmarks[159];
                const rightEye = landmarks[386];
                
                if (leftEye && rightEye) {
                    // Draw debug points
                    this.ctx.fillStyle = "#10b981";
                    this.drawPoint(leftEye);
                    this.drawPoint(rightEye);
                    
                    // Calculate light parameters
                    const midX = (leftEye.x + rightEye.x) / 2;
                    const midY = (leftEye.y + rightEye.y) / 2;
                    
                    const eyeDist = Math.sqrt(
                        Math.pow(rightEye.x - leftEye.x, 2) + 
                        Math.pow(rightEye.y - leftEye.y, 2)
                    );
                    
                    if (!this.baseline) {
                        this.baseline = { midX, midY, eyeDist };
                    }
                    
                    const deltaX = midX - this.baseline.midX;
                    const deltaY = midY - this.baseline.midY;
                    const deltaDist = eyeDist - this.baseline.eyeDist;
                    
                    // Map to 3D space from center base
                    // X follows head movement (camera is mirrored)
                    const targetX = this.baseCenter.x + deltaX * 5.0; 
                    const targetY = this.baseCenter.y - deltaY * 5.0; 
                    
                    // Closer to camera -> larger eyeDist (positive delta) -> closer light (larger Z)
                    const targetZ = this.baseCenter.z + deltaDist * 20.0;
                    
                    // Smooth the movement
                    this.lightPos.x += (targetX - this.lightPos.x) * 0.2;
                    this.lightPos.y += (targetY - this.lightPos.y) * 0.2;
                    this.lightPos.z += (targetZ - this.lightPos.z) * 0.2;
                    
                    if (this.onLightUpdate) {
                        this.onLightUpdate(this.lightPos);
                    }
                }
            }
        }
        
        requestAnimationFrame(() => this.renderLoop());
    }
    
    drawPoint(landmark) {
        const x = landmark.x * this.canvas.width;
        const y = landmark.y * this.canvas.height;
        this.ctx.beginPath();
        this.ctx.arc(x, y, 4, 0, 2 * Math.PI);
        this.ctx.fill();
    }
}
