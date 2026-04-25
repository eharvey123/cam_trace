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
            format: 'rgba8unorm',
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
                    return textureSample(myTexture, mySampler, uv);
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
        // 12-14: cameraDir, 15: padding
        this.uniformBuffer = this.device.createBuffer({
            size: 64, // 16 * 4
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
        this.uniformData[12] = 0.0;
        this.uniformData[13] = 0.0;
        this.uniformData[14] = 1.0;
        this.uniformData[15] = this.usePathTracing ? 0.0 : 1.0;
        
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
