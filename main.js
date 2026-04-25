import { Tracker } from './tracker.js';
import { Renderer } from './renderer.js';

async function main() {
    const statusText = document.getElementById('status-text');
    const startBtn = document.getElementById('start-btn');
    const canvas = document.getElementById('webgpu-canvas');
    const metricX = document.getElementById('metric-x');
    const metricY = document.getElementById('metric-y');
    const metricZ = document.getElementById('metric-z');


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

    // Start render loop
    let gameState = {
        isPlaying: true,
        health: 100,
        score: 0,
        speed: 5.0,
        tunnelOffset: 0,
        lastTime: performance.now(),
        obstacles: [],
        spawnTimer: 0,
        iFrames: 0,
        particles: []
    };

    const scoreValue = document.getElementById('score-value');
    const healthBar = document.getElementById('health-bar');
    const gameOverScreen = document.getElementById('game-over-screen');
    const finalScore = document.getElementById('final-score');

    function resetGame() {
        gameState.isPlaying = true;
        gameState.health = 100;
        gameState.score = 0;
        gameState.speed = 5.0;
        gameState.obstacles = [];
        gameState.iFrames = 0;
        gameState.lastTime = performance.now();
        healthBar.style.width = '100%';
        scoreValue.innerText = '0';
        gameOverScreen.style.display = 'none';
        renderer.resetAccumulation();
    }

    window.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !gameState.isPlaying) {
            resetGame();
        }
    });

    function spawnObstacle() {
        const difficulty = Math.min(1.0, gameState.score / 2000.0);
        const isDynamic = Math.random() < difficulty;
        const x = (Math.random() - 0.5) * 1.5;

        const shapeId = Math.random() > 0.5 ? 1 : 0; // 0=box, 1=sphere
        const isMetallic = Math.random() > 0.5;
        const metallic = isMetallic ? 1.0 : 0.0;
        const roughness = isMetallic ? (Math.random() > 0.5 ? 0.0 : 0.2) : 1.0;

        const colorTypes = [
            [0.8, 0.1, 0.1], // Red
            [0.1, 0.8, 0.1], // Green
            [0.1, 0.5, 0.9], // Blue
            [0.9, 0.8, 0.1], // Yellow
            [0.8, 0.8, 0.8]  // White
        ];
        const color = colorTypes[Math.floor(Math.random() * colorTypes.length)];

        // 20% chance to be highly emissive
        const isEmissive = Math.random() > 0.8;
        const intensity = 5.0 + (gameState.score / 500.0) * 10.0;
        const emission = isEmissive ? [color[0] * intensity, color[1] * intensity, color[2] * intensity] : [0.0, 0.0, 0.0];

        gameState.obstacles.push({
            x: x, // relative to tunnel center
            y: (Math.random() - 0.5) * 1.5, // relative to tunnel center
            z: 10.0,
            renderX: 0,
            renderY: 0,
            w: 0.15 + Math.random() * 0.15, // size or radius
            h: 0.15 + Math.random() * 0.15,
            d: 0.1,
            shapeId: shapeId,
            metallic: metallic,
            roughness: roughness,
            r: color[0],
            g: color[1],
            b: color[2],
            er: emission[0],
            eg: emission[1],
            eb: emission[2],
            dynamic: isDynamic,
            startX: x,
            timeOffset: Math.random() * Math.PI * 2
        });
    }
    function getCurveOffset(z, tunnelOffset) {
        const localZ = z + tunnelOffset;
        const curveX = Math.sin(localZ * 0.2) * 2.0;
        const curveY = Math.cos(localZ * 0.15) * 1.0;
        return { x: curveX, y: curveY };
    }
    
    function spawnExplosion(obs) {
        for (let i = 0; i < 20; i++) {
            gameState.particles.push({
                x: obs.renderX + (Math.random() - 0.5) * obs.w,
                y: obs.renderY + (Math.random() - 0.5) * obs.h,
                z: obs.z,
                vx: (Math.random() - 0.5) * 4.0,
                vy: (Math.random() - 0.5) * 4.0 + 2.0,
                vz: (Math.random() - 0.5) * 4.0,
                radius: 0.02 + Math.random() * 0.03,
                r: obs.er > 0 ? obs.r : 1.0,
                g: obs.eg > 0 ? obs.g : 0.5,
                b: obs.eb > 0 ? obs.b : 0.2,
                intensity: obs.er > 0 ? 10.0 : 5.0,
                life: 1.0 + Math.random()
            });
        }
    }

    function updateGame() {
        const now = performance.now();
        const dt = (now - gameState.lastTime) / 1000.0;
        gameState.lastTime = now;

        if (!gameState.isPlaying || dt > 0.1) return;

        renderer.resetAccumulation(); // Prevent smearing while moving

        gameState.score += dt * 10 * (gameState.speed / 5.0);
        scoreValue.innerText = Math.floor(gameState.score).toString();

        gameState.speed += dt * 0.05;
        gameState.tunnelOffset += gameState.speed * dt;

        gameState.spawnTimer -= dt;
        const spawnRate = Math.max(0.3, 1.0 - (gameState.score / 2000.0));
        if (gameState.spawnTimer <= 0 && gameState.obstacles.length < 10) {
            spawnObstacle();
            gameState.spawnTimer = spawnRate;
        }

        for (let i = gameState.obstacles.length - 1; i >= 0; i--) {
            let obs = gameState.obstacles[i];
            obs.z -= gameState.speed * dt;

            const curve = getCurveOffset(obs.z, gameState.tunnelOffset);
            obs.renderX = obs.x + curve.x;
            obs.renderY = obs.y + curve.y;

            if (obs.dynamic) {
                obs.renderX += Math.sin(now / 500.0 + obs.timeOffset) * 0.5;
            }

            if (obs.z < -2.0) {
                gameState.obstacles.splice(i, 1);
            }
        }
        
        // Update particles
        for (let i = gameState.particles.length - 1; i >= 0; i--) {
            let p = gameState.particles[i];
            p.life -= dt;
            if (p.life <= 0) {
                gameState.particles.splice(i, 1);
                continue;
            }
            p.vy -= 9.8 * dt; // gravity
            p.x += p.vx * dt;
            p.y += p.vy * dt;
            p.z += p.vz * dt;
            
            // Bounce off curving tunnel walls approximately
            const curve = getCurveOffset(p.z, gameState.tunnelOffset);
            const dx = p.x - curve.x;
            const dy = p.y - 1.0 - curve.y;
            
            if (Math.abs(dx) > 1.9) { p.vx *= -0.7; p.x = p.x > curve.x ? curve.x + 1.9 : curve.x - 1.9; }
            if (dy < -1.9) { p.vy *= -0.7; p.y = curve.y + 1.0 - 1.9; }
            if (dy > 1.9) { p.vy *= -0.7; p.y = curve.y + 1.0 + 1.9; }
        }

        if (gameState.iFrames > 0) {
            gameState.iFrames -= dt;
        } else {
            const lightRad = 0.15;
            const lp = renderer.lightPos;
            for (let obs of gameState.obstacles) {
                let hit = false;

                if (obs.shapeId === 1) {
                    // Sphere collision
                    const dx = lp.x - obs.renderX;
                    const dy = lp.y - obs.renderY;
                    const dz = lp.z - obs.z;
                    const distSq = dx * dx + dy * dy + dz * dz;
                    const totalRad = obs.w + lightRad;
                    if (distSq < totalRad * totalRad) hit = true;
                } else {
                    // Box collision
                    const dx = Math.max(obs.renderX - obs.w, Math.min(lp.x, obs.renderX + obs.w)) - lp.x;
                    const dy = Math.max(obs.renderY - obs.h, Math.min(lp.y, obs.renderY + obs.h)) - lp.y;
                    const dz = Math.max(obs.z - obs.d, Math.min(lp.z, obs.z + obs.d)) - lp.z;
                    const distSq = dx * dx + dy * dy + dz * dz;
                    if (distSq < lightRad * lightRad) hit = true;
                }

                if (hit) {
                    spawnExplosion(obs);
                    gameState.obstacles.splice(gameState.obstacles.indexOf(obs), 1);
                    
                    gameState.health -= 25;
                    gameState.iFrames = 1.0;

                    healthBar.style.width = Math.max(0, gameState.health) + '%';

                    document.body.classList.remove('damage-flash');
                    void document.body.offsetWidth;
                    document.body.classList.add('damage-flash');

                    if (gameState.health <= 0) {
                        gameState.isPlaying = false;
                        gameOverScreen.style.display = 'flex';
                        finalScore.innerText = Math.floor(gameState.score).toString();
                    }
                    break;
                }
            }
        }

        // Pass to renderer using renderX and renderY
        const renderObstacles = gameState.obstacles.map(obs => ({
            ...obs,
            x: obs.renderX,
            y: obs.renderY
        }));
        renderer.setObstacles(renderObstacles);
        renderer.setParticles(gameState.particles);
        renderer.setTunnelOffset(gameState.tunnelOffset);
        
        // Player light reach falls off as score increases
        const reach = Math.max(0.5, 10.0 - (gameState.score / 2000.0) * 9.5);
        renderer.setPlayerLightReach(reach);
    }

    function renderLoop() {
        updateGame();
        renderer.render();
        requestAnimationFrame(renderLoop);
    }

    renderLoop();
}

// Start app
window.addEventListener('load', main);
