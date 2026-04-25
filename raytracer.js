export const wgslSource = `
struct Uniforms {
    lightPos: vec3<f32>,
    frameCounter: f32,
    resolution: vec2<f32>,
    cameraPos: vec3<f32>,
    cameraDir: vec3<f32>,
    renderMode: f32,
    tunnelOffset: f32,
    numObstacles: f32,
    playerLightReach: f32,
    time: f32,
    obstacleCenters: array<vec4<f32>, 10>,
    obstacleSizes: array<vec4<f32>, 10>,
    obstacleColors: array<vec4<f32>, 10>,
    obstacleEmissions: array<vec4<f32>, 10>,
    
    numParticles: f32,
    padding3: f32,
    padding4: f32,
    padding5: f32,
    
    particlePositions: array<vec4<f32>, 50>,
    particleColors: array<vec4<f32>, 50>,
}

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var prevAccumulation: texture_2d<f32>;
@group(0) @binding(2) var nextAccumulation: texture_storage_2d<rgba32float, write>;
@group(0) @binding(3) var renderTarget: texture_storage_2d<rgba16float, write>;

const MAX_BOUNCES: i32 = 4;
const SAMPLES_PER_PIXEL: i32 = 1;

struct Ray {
    origin: vec3<f32>,
    direction: vec3<f32>,
}

struct Material {
    color: vec3<f32>,
    emission: vec3<f32>,
    roughness: f32,
    metallic: f32,
}

struct Hit {
    dist: f32,
    normal: vec3<f32>,
    mat: Material,
}

// PRNG state
var<private> state: u32;

fn pcg_hash(input: u32) -> u32 {
    var h = input * 747796405u + 2891336453u;
    h = ((h >> ((h >> 28u) + 4u)) ^ h) * 277803737u;
    return (h >> 22u) ^ h;
}

fn rand() -> f32 {
    state = pcg_hash(state);
    return f32(state) / f32(0xFFFFFFFFu);
}

fn random_hemisphere_cosine(normal: vec3<f32>) -> vec3<f32> {
    let u1 = rand();
    let u2 = rand();
    
    let r = sqrt(u1);
    let theta = 2.0 * 3.14159265 * u2;
    
    let x = r * cos(theta);
    let y = r * sin(theta);
    let z = sqrt(max(0.0, 1.0 - u1));
    
    // Construct orthonormal basis around normal
    let up = select(vec3<f32>(0.0, 1.0, 0.0), vec3<f32>(1.0, 0.0, 0.0), abs(normal.y) > 0.999);
    let right = normalize(cross(up, normal));
    let forward = cross(normal, right);
    
    return right * x + forward * y + normal * z;
}

fn intersect_plane(ray: Ray, normal: vec3<f32>, d: f32) -> f32 {
    let denom = dot(normal, ray.direction);
    if abs(denom) > 1e-6 {
        let t = -(dot(normal, ray.origin) + d) / denom;
        if t > 1e-4 { return t; }
    }
    return -1.0;
}

fn intersect_sphere(ray: Ray, center: vec3<f32>, radius: f32) -> f32 {
    let oc = ray.origin - center;
    let b = dot(oc, ray.direction);
    let c = dot(oc, oc) - radius * radius;
    let discriminant = b * b - c;
    
    if discriminant > 0.0 {
        let t = -b - sqrt(discriminant);
        if t > 1e-4 { return t; }
    }
    return -1.0;
}

fn intersect_box(ray: Ray, boxMin: vec3<f32>, boxMax: vec3<f32>, outNormal: ptr<function, vec3<f32>>) -> f32 {
    let t0 = (boxMin - ray.origin) / ray.direction;
    let t1 = (boxMax - ray.origin) / ray.direction;
    let tmin = min(t0, t1);
    let tmax = max(t0, t1);
    
    let tNear = max(max(tmin.x, tmin.y), tmin.z);
    let tFar = min(min(tmax.x, tmax.y), tmax.z);
    
    if tNear > tFar || tFar < 1e-4 { return -1.0; }
    
    if tNear > 1e-4 {
        if tNear == tmin.x { *outNormal = vec3<f32>(-sign(ray.direction.x), 0.0, 0.0); }
        else if tNear == tmin.y { *outNormal = vec3<f32>(0.0, -sign(ray.direction.y), 0.0); }
        else { *outNormal = vec3<f32>(0.0, 0.0, -sign(ray.direction.z)); }
        return tNear;
    }
    return -1.0;
}

fn get_curve_offset(z: f32) -> vec2<f32> {
    let localZ = z + uniforms.tunnelOffset;
    let curveX = sin(localZ * 0.2) * 2.0;
    let curveY = cos(localZ * 0.15) * 1.0;
    return vec2<f32>(curveX, curveY);
}

fn sdTunnel(p: vec3<f32>) -> f32 {
    let curve = get_curve_offset(p.z);
    let q = vec2<f32>(p.x - curve.x, p.y - 1.0 - curve.y); // center tunnel at y=1.0
    let d = abs(q) - vec2<f32>(2.0, 2.0);
    return -(min(max(d.x, d.y), 0.0) + length(max(d, vec2<f32>(0.0))));
}

fn raymarch_tunnel(ray: Ray) -> Hit {
    var t = 0.01;
    var hitDist = 10000.0;
    var p = vec3<f32>(0.0);
    
    for(var i=0; i<150; i++) {
        p = ray.origin + ray.direction * t;
        let d = sdTunnel(p);
        if d < 0.001 {
            hitDist = t;
            break;
        }
        t += d * 0.8; // Domain distortion safety factor
        if t > 100.0 { break; }
    }
    
    var hit = Hit(10000.0, vec3<f32>(0.0), Material(vec3<f32>(0.0), vec3<f32>(0.0), 1.0, 0.0));
    if hitDist < 100.0 {
        let eps = 0.01;
        let nx = sdTunnel(p + vec3<f32>(eps, 0.0, 0.0)) - sdTunnel(p - vec3<f32>(eps, 0.0, 0.0));
        let ny = sdTunnel(p + vec3<f32>(0.0, eps, 0.0)) - sdTunnel(p - vec3<f32>(0.0, eps, 0.0));
        let nz = sdTunnel(p + vec3<f32>(0.0, 0.0, eps)) - sdTunnel(p - vec3<f32>(0.0, 0.0, eps));
        let hitNormal = normalize(vec3<f32>(nx, ny, nz));
        
        let curve = get_curve_offset(p.z);
        let uq = vec2<f32>(p.x - curve.x, p.y - 1.0 - curve.y);
        
        var col = vec3<f32>(0.0);
        if abs(hitNormal.y) > 0.5 {
            let grid = max(abs(fract(uq.x) - 0.5), abs(fract(p.z + uniforms.tunnelOffset) - 0.5));
            col = mix(vec3<f32>(0.1, 0.1, 0.15), vec3<f32>(0.2, 0.6, 1.0), step(0.48, grid));
        } else {
            let grid = max(abs(fract(uq.y) - 0.5), abs(fract(p.z + uniforms.tunnelOffset) - 0.5));
            col = mix(vec3<f32>(0.15, 0.1, 0.1), vec3<f32>(1.0, 0.2, 0.2), step(0.48, grid));
        }
        
        hit = Hit(hitDist, hitNormal, Material(col, vec3<f32>(0.0), 0.5, 0.0));
    }
    return hit;
}



fn get_scene_intersection(ray: Ray) -> Hit {
    var hit = raymarch_tunnel(ray);
    
    // Default materials
    let matWhite = Material(vec3<f32>(0.8, 0.8, 0.8), vec3<f32>(0.0), 1.0, 0.0);
    let matRed = Material(vec3<f32>(0.8, 0.1, 0.1), vec3<f32>(0.0), 1.0, 0.0);
    let matGreen = Material(vec3<f32>(0.1, 0.8, 0.1), vec3<f32>(0.0), 1.0, 0.0);
    let matMetal = Material(vec3<f32>(0.9, 0.9, 0.9), vec3<f32>(0.0), 0.1, 1.0);
    
    // Dynamic light based on eyes
    let matLight = Material(vec3<f32>(1.0, 1.0, 1.0), vec3<f32>(5.0, 5.0, 5.0), 1.0, 0.0);


    
    // Obstacles
    let numObs = min(10, i32(uniforms.numObstacles));
    for (var i = 0; i < numObs; i++) {
        var objNorm = vec3<f32>(0.0);
        let center = uniforms.obstacleCenters[i].xyz;
        let shapeId = uniforms.obstacleCenters[i].w;
        let size = uniforms.obstacleSizes[i].xyz;
        let metallic = uniforms.obstacleSizes[i].w;
        let color = uniforms.obstacleColors[i].xyz;
        let roughness = uniforms.obstacleColors[i].w;
        let emission = uniforms.obstacleEmissions[i].xyz;
        
        var tObj = -1.0;
        if shapeId > 0.5 {
            // Sphere
            tObj = intersect_sphere(ray, center, size.x);
            if tObj > 0.0 {
                objNorm = normalize((ray.origin + ray.direction * tObj) - center);
            }
        } else {
            // Box
            let boxMin = center - size;
            let boxMax = center + size;
            tObj = intersect_box(ray, boxMin, boxMax, &objNorm);
        }
        
        if tObj > 0.0 && tObj < hit.dist {
            hit = Hit(tObj, objNorm, Material(color, emission, roughness, metallic));
        }
    }
    
    // Particles
    let numParticles = min(50, i32(uniforms.numParticles));
    for (var i = 0; i < numParticles; i++) {
        let pPos = uniforms.particlePositions[i].xyz;
        let pRad = uniforms.particlePositions[i].w;
        let pCol = uniforms.particleColors[i].xyz;
        let pInt = uniforms.particleColors[i].w;
        
        let tSphere = intersect_sphere(ray, pPos, pRad);
        if tSphere > 0.0 && tSphere < hit.dist {
            let hp = ray.origin + ray.direction * tSphere;
            let normal = normalize(hp - pPos);
            let pMat = Material(pCol, pCol * pInt, 1.0, 0.0);
            hit = Hit(tSphere, normal, pMat);
        }
    }
    
    // Dynamic Eye Light Sphere
    let tLight = intersect_sphere(ray, uniforms.lightPos, 0.15);
    if tLight > 0.0 && tLight < hit.dist {
        let norm = normalize((ray.origin + ray.direction * tLight) - uniforms.lightPos);
        hit = Hit(tLight, norm, matLight);
    }

    return hit;
}

fn ray_trace(ray: Ray) -> vec3<f32> {
    let hit = get_scene_intersection(ray);
    if hit.dist > 9999.0 { return vec3<f32>(0.0); }
    
    if dot(hit.mat.emission, hit.mat.emission) > 0.0 {
        return hit.mat.emission;
    }
    
    let hitPoint = ray.origin + ray.direction * hit.dist;
    
    // Stochastic Soft Shadow Ray
    let lightRadius = 0.15;
    let baseLightDir = normalize(uniforms.lightPos - hitPoint);
    let jitter = random_hemisphere_cosine(baseLightDir) * lightRadius;
    let lightTarget = uniforms.lightPos + jitter;
    let lightDir = normalize(lightTarget - hitPoint);
    
    let shadowRay = Ray(hitPoint + hit.normal * 0.01, lightDir);
    let shadowHit = get_scene_intersection(shadowRay);
    
    // Attenuation factor to control how far light reaches before diminishing
    let lightDist = length(lightTarget - hitPoint);
    let attenuation = min(1.0, uniforms.playerLightReach / (lightDist * lightDist + 0.01));
    
    var color = vec3<f32>(0.0);
    
    if hit.mat.metallic > 0.5 {
        // Reflection ray
        let reflectDir = reflect(ray.direction, hit.normal);
        let fuzz = random_hemisphere_cosine(hit.normal) * hit.mat.roughness;
        let finalReflectDir = normalize(reflectDir + fuzz);
        
        // Prevent tracing below the surface
        if dot(finalReflectDir, hit.normal) > 0.0 {
            let reflectRay = Ray(hitPoint + hit.normal * 0.01, finalReflectDir);
            let reflectHit = get_scene_intersection(reflectRay);
            
            if reflectHit.dist < 9999.0 {
                if dot(reflectHit.mat.emission, reflectHit.mat.emission) > 0.0 {
                    color += reflectHit.mat.emission * hit.mat.color;
                } else {
                    // One bounce of diffuse lighting for the reflection
                    let rHitPoint = reflectRay.origin + reflectRay.direction * reflectHit.dist;
                    let rLightTarget = uniforms.lightPos + random_hemisphere_cosine(normalize(uniforms.lightPos - rHitPoint)) * lightRadius;
                    let rLightDir = normalize(rLightTarget - rHitPoint);
                    
                    let rShadowRay = Ray(rHitPoint + reflectHit.normal * 1e-4, rLightDir);
                    let rShadowHit = get_scene_intersection(rShadowRay);
                    
                    if dot(rShadowHit.mat.emission, rShadowHit.mat.emission) > 0.0 {
                        let rNDotL = max(0.0, dot(reflectHit.normal, rLightDir));
                        color += hit.mat.color * reflectHit.mat.color * (rNDotL * 1.5);
                    }
                }
            }
        }
        
        // Add direct specular
        if dot(shadowHit.mat.emission, shadowHit.mat.emission) > 0.0 {
            let h = normalize(lightDir - ray.direction);
            let nDotH = max(0.0, dot(hit.normal, h));
            let spec = pow(nDotH, 32.0 * (1.0 - hit.mat.roughness));
            color += shadowHit.mat.emission * spec * hit.mat.metallic * attenuation;
        }
        
    } else {
        // Diffuse
        if dot(shadowHit.mat.emission, shadowHit.mat.emission) > 0.0 {
            let nDotL = max(0.0, dot(hit.normal, lightDir));
            color += hit.mat.color * nDotL * 1.5 * attenuation; 
        }
    }
    
    return color;
}

fn path_trace(initialRay: Ray) -> vec3<f32> {
    if uniforms.renderMode > 0.5 {
        return ray_trace(initialRay);
    }

    var ray = initialRay;
    var throughput = vec3<f32>(1.0);
    var accumulated_color = vec3<f32>(0.0);
    
    for (var i = 0; i < MAX_BOUNCES; i++) {
        let hit = get_scene_intersection(ray);
        
        if hit.dist > 9999.0 {
            accumulated_color += throughput * vec3<f32>(0.0); // Black background
            break;
        }
        
        let hitPoint = ray.origin + ray.direction * hit.dist;
        
        // Add emission
        accumulated_color += throughput * hit.mat.emission;
        
        if dot(hit.mat.emission, hit.mat.emission) > 0.0 {
            break; // Stop if we hit a light
        }
        
        // Calculate next ray direction
        var newDir: vec3<f32>;
        if hit.mat.metallic > 0.5 {
            // Metallic reflection
            let reflectDir = reflect(ray.direction, hit.normal);
            let fuzz = random_hemisphere_cosine(hit.normal) * hit.mat.roughness;
            newDir = normalize(reflectDir + fuzz);
            // Catch rays that reflect below surface
            if dot(newDir, hit.normal) < 0.0 {
                break;
            }
        } else {
            // Diffuse reflection
            newDir = random_hemisphere_cosine(hit.normal);
        }
        
        ray.origin = hitPoint + hit.normal * 1e-4;
        ray.direction = newDir;
        throughput *= hit.mat.color;
        
        // Russian Roulette
        if i > 2 {
            let p = max(throughput.x, max(throughput.y, throughput.z));
            if rand() > p {
                break;
            }
            throughput /= p;
        }
    }
    
    return accumulated_color;
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) GlobalInvocationID: vec3<u32>) {
    let screenPos = vec2<f32>(f32(GlobalInvocationID.x), f32(GlobalInvocationID.y));
    if screenPos.x >= uniforms.resolution.x || screenPos.y >= uniforms.resolution.y {
        return;
    }

    // Seed RNG
    state = u32(screenPos.x) * 1973u + u32(screenPos.y) * 9277u + u32(uniforms.frameCounter) * 26699u;

    // Anti-aliasing jitter
    let jitter = vec2<f32>(rand() - 0.5, rand() - 0.5);
    let uv = (screenPos + jitter) / uniforms.resolution;
    
    // Normalized device coordinates (-1 to 1)
    let ndc = uv * 2.0 - 1.0;
    
    // Setup camera
    let aspect = uniforms.resolution.x / uniforms.resolution.y;
    let fov = 1.0;
    
    let forward = normalize(uniforms.cameraDir);
    let up = vec3<f32>(0.0, 1.0, 0.0);
    let right = normalize(cross(up, forward));
    
    let dir = normalize(forward + ndc.x * aspect * fov * right - ndc.y * fov * up); 
    
    let ray = Ray(uniforms.cameraPos, dir);
    
    var color = vec3<f32>(0.0);
    for (var i = 0; i < SAMPLES_PER_PIXEL; i++) {
        color += path_trace(ray);
    }
    color /= f32(SAMPLES_PER_PIXEL);
    
    // Accumulation
    var finalColor = color;
    if uniforms.frameCounter > 0.0 {
        let prevColor = textureLoad(prevAccumulation, vec2<i32>(GlobalInvocationID.xy), 0).rgb;
        finalColor = mix(prevColor, color, 1.0 / (uniforms.frameCounter + 1.0));
    }
    
    // Write back to accumulation buffer
    textureStore(nextAccumulation, vec2<i32>(GlobalInvocationID.xy), vec4<f32>(finalColor, 1.0));
    
    // Tonemapping and gamma correction
    let mapped = finalColor / (finalColor + vec3<f32>(1.0));
    let gamma = pow(mapped, vec3<f32>(1.0 / 2.2));
    
    textureStore(renderTarget, vec2<i32>(GlobalInvocationID.xy), vec4<f32>(gamma, 1.0));
}
`;
