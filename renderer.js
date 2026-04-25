import { wgslSource } from './raytracer.js';

export class Renderer {
    constructor(canvas) {
        this.canvas = canvas;
        this.adapter = null;
        this.device = null;
        this.context = null;
        this.format = null;
        
        this.pipeline = null;
        this.blitPipeline = null;
        this.bindGroup = null;
        this.blitBindGroup = null;
        
        this.uniformBuffer = null;
        this.uniformData = new Float32Array(16); // 16 floats = 64 bytes
        
        this.accumulationTextures = [null, null];
        this.renderTargetTexture = null;
        this.bindGroups = [null, null];
        
        this.frameCounter = 0;
        
        this.lightPos = { x: 0, y: 1.0, z: -0.5 };
        this.lastLightPos = { ...this.lightPos };
        
        this.usePathTracing = true;
        this.gameObstacles = [];
        this.tunnelOffset = 0.0;
        this.cameraDir = { x: 0.0, y: 0.0, z: 1.0 };
        this.playerLightReach = 10.0;
    }

    async initialize() {
        if (!navigator.gpu) {
            throw new Error("WebGPU is not supported in this browser.");
        }
        
        this.adapter = await navigator.gpu.requestAdapter();
        if (!this.adapter) {
            throw new Error("Failed to request WebGPU adapter.");
        }
        
        this.device = await this.adapter.requestDevice();
        this.context = this.canvas.getContext('webgpu');
        this.format = navigator.gpu.getPreferredCanvasFormat();
        
        this.context.configure({
            device: this.device,
            format: this.format,
            alphaMode: 'premultiplied'
        });

        this.resize();
        
        await this.setupPipelines();
        
        window.addEventListener('resize', () => {
            this.resize();
            this.setupTextures();
            this.setupBindGroups();
            this.resetAccumulation();
        });
    }

    resize() {
        this.canvas.width = window.innerWidth;
        this.canvas.height = window.innerHeight;
    }
    
    resetAccumulation() {
        this.frameCounter = 0;
    }
    
    setLightPos(pos) {
        // Only reset if light moved significantly
        const dist = Math.sqrt(
            Math.pow(pos.x - this.lastLightPos.x, 2) +
            Math.pow(pos.y - this.lastLightPos.y, 2) +
            Math.pow(pos.z - this.lastLightPos.z, 2)
        );
        
        if (dist > 0.05) {
            this.resetAccumulation();
            this.lastLightPos = { ...pos };
        }
        
        this.lightPos = { ...pos };
    }
    
    setObstacles(obstacles) {
        this.gameObstacles = obstacles;
    }
    
    setTunnelOffset(offset) {
        this.tunnelOffset = offset;
    }
    
    setCameraDir(dir) {
        this.cameraDir = dir;
    }

    setPlayerLightReach(reach) {
        this.playerLightReach = reach;
    }
    
    setParticles(particles) {
        this.particles = particles;
    }

    setupTextures() {
        if (this.accumulationTextures[0]) {
            this.accumulationTextures[0].destroy();
            this.accumulationTextures[1].destroy();
            this.renderTargetTexture.destroy();
        }

        const size = [this.canvas.width, this.canvas.height, 1];
        
        for (let i = 0; i < 2; i++) {
            this.accumulationTextures[i] = this.device.createTexture({
                size,
                format: 'rgba32float',
                usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING
            });
        }
        
        this.renderTargetTexture = this.device.createTexture({
            size,
            format: 'rgba16float',
            usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING
        });
    }

    async setupPipelines() {
        const module = this.device.createShaderModule({
            code: wgslSource
        });
        
        this.pipeline = this.device.createComputePipeline({
            layout: 'auto',
            compute: {
                module,
                entryPoint: 'main'
            }
        });
        
        // Simple blit shader to copy renderTarget to canvas
        const blitModule = this.device.createShaderModule({
            code: `
                @group(0) @binding(0) var myTexture: texture_2d<f32>;
                @group(0) @binding(1) var mySampler: sampler;
                
                struct VertexOutput {
                    @builtin(position) position: vec4<f32>,
                    @location(0) uv: vec2<f32>,
                }
                
                @vertex
                fn vs_main(@builtin(vertex_index) VertexIndex: u32) -> VertexOutput {
                    var pos = array<vec2<f32>, 3>(
                        vec2<f32>(-1.0, -1.0),
                        vec2<f32>(3.0, -1.0),
                        vec2<f32>(-1.0, 3.0)
                    );
                    var output: VertexOutput;
                    output.position = vec4<f32>(pos[VertexIndex], 0.0, 1.0);
                    output.uv = pos[VertexIndex] * vec2<f32>(0.5, -0.5) + vec2<f32>(0.5, 0.5);
                    return output;
                }
                
                @fragment
                fn fs_main(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
                    var color = textureSample(myTexture, mySampler, uv).rgb;
                    
                    // Multi-tap Bloom (Pseudo-Gaussian)
                    var bloom = vec3<f32>(0.0);
                    let radius = vec2<f32>(1.0 / 800.0) * 15.0; // Bloom spread
                    let taps = 12.0;
                    
                    for(var i=0; i<12; i++) {
                        let angle = f32(i) * 3.14159 * 2.0 / taps;
                        let offset = vec2<f32>(cos(angle), sin(angle)) * radius;
                        let sampleCol = textureSample(myTexture, mySampler, uv + offset).rgb;
                        // Extract bright spots
                        let brightness = dot(sampleCol, vec3<f32>(0.2126, 0.7152, 0.0722));
                        if (brightness > 1.2) {
                            bloom += sampleCol * 0.15;
                        }
                    }
                    
                    // Add second outer ring for softer glare
                    for(var i=0; i<12; i++) {
                        let angle = f32(i) * 3.14159 * 2.0 / taps;
                        let offset = vec2<f32>(cos(angle), sin(angle)) * radius * 2.0;
                        let sampleCol = textureSample(myTexture, mySampler, uv + offset).rgb;
                        let brightness = dot(sampleCol, vec3<f32>(0.2126, 0.7152, 0.0722));
                        if (brightness > 1.2) {
                            bloom += sampleCol * 0.08;
                        }
                    }
                    
                    color += bloom;
                    
                    // Filmic Tonemapping
                    color = color / (color + vec3<f32>(1.0));
                    color = pow(color, vec3<f32>(1.0 / 2.2));
                    
                    return vec4<f32>(color, 1.0);
                }
            `
        });
        
        this.blitPipeline = this.device.createRenderPipeline({
            layout: 'auto',
            vertex: {
                module: blitModule,
                entryPoint: 'vs_main'
            },
            fragment: {
                module: blitModule,
                entryPoint: 'fs_main',
                targets: [{ format: this.format }]
            },
            primitive: {
                topology: 'triangle-list'
            }
        });

        // 16 floats: 
        // 0-2: lightPos, 3: frameCounter
        // 4-5: resolution, 6-7: padding
        // 8-10: cameraPos, 11: padding
        // 12-14: cameraDir, 15: renderMode
        // 16: tunnelOffset, 17: numObstacles, 18-19: padding
        // 140-179: obstacleEmissions (10x vec4)
        // 180: numParticles, 181-183: padding
        // 184-383: particlePositions (50x vec4)
        // 384-583: particleColors (50x vec4)
        this.uniformData = new Float32Array(600);
        this.uniformBuffer = this.device.createBuffer({
            size: 2400, // 600 * 4 bytes
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
        });

        this.setupTextures();
        this.setupBindGroups();
    }

    setupBindGroups() {
        for (let i = 0; i < 2; i++) {
            this.bindGroups[i] = this.device.createBindGroup({
                layout: this.pipeline.getBindGroupLayout(0),
                entries: [
                    { binding: 0, resource: { buffer: this.uniformBuffer } },
                    { binding: 1, resource: this.accumulationTextures[i].createView() },
                    { binding: 2, resource: this.accumulationTextures[(i + 1) % 2].createView() },
                    { binding: 3, resource: this.renderTargetTexture.createView() }
                ]
            });
        }
        
        const sampler = this.device.createSampler({
            magFilter: 'linear',
            minFilter: 'linear'
        });
        
        this.blitBindGroup = this.device.createBindGroup({
            layout: this.blitPipeline.getBindGroupLayout(0),
            entries: [
                { binding: 0, resource: this.renderTargetTexture.createView() },
                { binding: 1, resource: sampler }
            ]
        });
    }

    render() {
        if (!this.device) return;

        // Update uniforms
        // vec3 requires 16-byte alignment, so float indices: 
        // 0,1,2 = lightPos. 3 = frameCounter
        this.uniformData[0] = this.lightPos.x;
        this.uniformData[1] = this.lightPos.y;
        this.uniformData[2] = this.lightPos.z;
        this.uniformData[3] = this.frameCounter;
        
        // 4,5 = resolution
        this.uniformData[4] = this.canvas.width;
        this.uniformData[5] = this.canvas.height;
        
        // 8,9,10 = cameraPos
        this.uniformData[8] = 0.0;
        this.uniformData[9] = 1.0;
        this.uniformData[10] = -3.0;
        
        // 12,13,14 = cameraDir, 15 = renderMode (0.0=PathTracing, 1.0=RayTracing)
        this.uniformData[12] = this.cameraDir.x;
        this.uniformData[13] = this.cameraDir.y;
        this.uniformData[14] = this.cameraDir.z;
        this.uniformData[15] = 1.0;
        
        // 16 = tunnelOffset, 17 = numObstacles, 18 = playerLightReach, 19 = time
        this.uniformData[16] = this.tunnelOffset;
        this.uniformData[17] = this.gameObstacles ? this.gameObstacles.length : 0;
        this.uniformData[18] = this.playerLightReach;
        this.uniformData[19] = performance.now() / 1000.0;
        
        if (this.gameObstacles) {
            for (let i = 0; i < 10; i++) {
                if (i < this.gameObstacles.length) {
                    const obs = this.gameObstacles[i];
                    this.uniformData[20 + i*4 + 0] = obs.x;
                    this.uniformData[20 + i*4 + 1] = obs.y;
                    this.uniformData[20 + i*4 + 2] = obs.z;
                    this.uniformData[20 + i*4 + 3] = obs.shapeId;
                    
                    this.uniformData[60 + i*4 + 0] = obs.w;
                    this.uniformData[60 + i*4 + 1] = obs.h;
                    this.uniformData[60 + i*4 + 2] = obs.d;
                    this.uniformData[60 + i*4 + 3] = obs.metallic;
                    
                    this.uniformData[100 + i*4 + 0] = obs.r;
                    this.uniformData[100 + i*4 + 1] = obs.g;
                    this.uniformData[100 + i*4 + 2] = obs.b;
                    this.uniformData[100 + i*4 + 3] = obs.roughness;
                    
                    this.uniformData[140 + i*4 + 0] = obs.er;
                    this.uniformData[140 + i*4 + 1] = obs.eg;
                    this.uniformData[140 + i*4 + 2] = obs.eb;
                    this.uniformData[140 + i*4 + 3] = 0;
                } else {
                    this.uniformData[20 + i*4 + 0] = 0;
                    this.uniformData[60 + i*4 + 0] = 0;
                    this.uniformData[100 + i*4 + 0] = 0;
                    this.uniformData[140 + i*4 + 0] = 0;
                }
            }
        }
        
        // Particles
        this.uniformData[180] = this.particles ? this.particles.length : 0;
        if (this.particles) {
            for (let i = 0; i < 50; i++) {
                if (i < this.particles.length) {
                    const p = this.particles[i];
                    this.uniformData[184 + i*4 + 0] = p.x;
                    this.uniformData[184 + i*4 + 1] = p.y;
                    this.uniformData[184 + i*4 + 2] = p.z;
                    this.uniformData[184 + i*4 + 3] = p.radius;
                    
                    this.uniformData[384 + i*4 + 0] = p.r;
                    this.uniformData[384 + i*4 + 1] = p.g;
                    this.uniformData[384 + i*4 + 2] = p.b;
                    this.uniformData[384 + i*4 + 3] = p.intensity;
                } else {
                    this.uniformData[184 + i*4 + 0] = 0;
                    this.uniformData[384 + i*4 + 0] = 0;
                }
            }
        }
        
        this.device.queue.writeBuffer(this.uniformBuffer, 0, this.uniformData);

        const commandEncoder = this.device.createCommandEncoder();

        // 1. Compute Path Tracing Pass
        const computePass = commandEncoder.beginComputePass();
        computePass.setPipeline(this.pipeline);
        computePass.setBindGroup(0, this.bindGroups[this.frameCounter % 2]);
        
        const workgroupCountX = Math.ceil(this.canvas.width / 8);
        const workgroupCountY = Math.ceil(this.canvas.height / 8);
        computePass.dispatchWorkgroups(workgroupCountX, workgroupCountY, 1);
        computePass.end();

        // 2. Blit Pass
        const textureView = this.context.getCurrentTexture().createView();
        const renderPass = commandEncoder.beginRenderPass({
            colorAttachments: [{
                view: textureView,
                clearValue: { r: 0.0, g: 0.0, b: 0.0, a: 1.0 },
                loadOp: 'clear',
                storeOp: 'store'
            }]
        });
        
        renderPass.setPipeline(this.blitPipeline);
        renderPass.setBindGroup(0, this.blitBindGroup);
        renderPass.draw(3, 1, 0, 0);
        renderPass.end();

        this.device.queue.submit([commandEncoder.finish()]);
        
        this.frameCounter++;
    }
}
