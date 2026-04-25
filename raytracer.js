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
    padding1: f32,
    padding2: f32,
    obstacleCenters: array<vec4<f32>, 10>,
    obstacleSizesAndColors: array<vec4<f32>, 10>,
}

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var prevAccumulation: texture_2d<f32>;
@group(0) @binding(2) var nextAccumulation: texture_storage_2d<rgba32float, write>;
@group(0) @binding(3) var renderTarget: texture_storage_2d<rgba8unorm, write>;

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

fn get_scene_intersection(ray: Ray) -> Hit {
    var hit = Hit(10000.0, vec3<f32>(0.0), Material(vec3<f32>(0.0), vec3<f32>(0.0), 1.0, 0.0));
    
    // Default materials
    let matWhite = Material(vec3<f32>(0.8, 0.8, 0.8), vec3<f32>(0.0), 1.0, 0.0);
    let matRed = Material(vec3<f32>(0.8, 0.1, 0.1), vec3<f32>(0.0), 1.0, 0.0);
    let matGreen = Material(vec3<f32>(0.1, 0.8, 0.1), vec3<f32>(0.0), 1.0, 0.0);
    let matMetal = Material(vec3<f32>(0.9, 0.9, 0.9), vec3<f32>(0.0), 0.1, 1.0);
    
    // Dynamic light based on eyes
    let matLight = Material(vec3<f32>(1.0, 1.0, 1.0), vec3<f32>(5.0, 5.0, 5.0), 1.0, 0.0);

    // Floor
    let tFloor = intersect_plane(ray, vec3<f32>(0.0, 1.0, 0.0), 1.0);
    if tFloor > 0.0 && tFloor < hit.dist { 
        let hp = ray.origin + ray.direction * tFloor;
        let grid = max(abs(fract(hp.x) - 0.5), abs(fract(hp.z + uniforms.tunnelOffset) - 0.5));
        let col = mix(vec3<f32>(0.1, 0.1, 0.15), vec3<f32>(0.2, 0.6, 1.0), step(0.48, grid));
        hit = Hit(tFloor, vec3<f32>(0.0, 1.0, 0.0), Material(col, vec3<f32>(0.0), 0.5, 0.0));
    }
    
    // Ceiling
    let tCeil = intersect_plane(ray, vec3<f32>(0.0, -1.0, 0.0), 1.0);
    if tCeil > 0.0 && tCeil < hit.dist { 
        let hp = ray.origin + ray.direction * tCeil;
        let grid = max(abs(fract(hp.x) - 0.5), abs(fract(hp.z + uniforms.tunnelOffset) - 0.5));
        let col = mix(vec3<f32>(0.1, 0.1, 0.15), vec3<f32>(0.2, 0.6, 1.0), step(0.48, grid));
        hit = Hit(tCeil, vec3<f32>(0.0, -1.0, 0.0), Material(col, vec3<f32>(0.0), 0.5, 0.0));
    }
    
    // Left wall
    let tLeft = intersect_plane(ray, vec3<f32>(1.0, 0.0, 0.0), 2.0);
    if tLeft > 0.0 && tLeft < hit.dist { 
        let hp = ray.origin + ray.direction * tLeft;
        let grid = max(abs(fract(hp.y) - 0.5), abs(fract(hp.z + uniforms.tunnelOffset) - 0.5));
        let col = mix(vec3<f32>(0.15, 0.1, 0.1), vec3<f32>(1.0, 0.2, 0.2), step(0.48, grid));
        hit = Hit(tLeft, vec3<f32>(1.0, 0.0, 0.0), Material(col, vec3<f32>(0.0), 0.5, 0.0));
    }
    
    // Right wall
    let tRight = intersect_plane(ray, vec3<f32>(-1.0, 0.0, 0.0), 2.0);
    if tRight > 0.0 && tRight < hit.dist { 
        let hp = ray.origin + ray.direction * tRight;
        let grid = max(abs(fract(hp.y) - 0.5), abs(fract(hp.z + uniforms.tunnelOffset) - 0.5));
        let col = mix(vec3<f32>(0.1, 0.15, 0.1), vec3<f32>(0.2, 1.0, 0.2), step(0.48, grid));
        hit = Hit(tRight, vec3<f32>(-1.0, 0.0, 0.0), Material(col, vec3<f32>(0.0), 0.5, 0.0));
    }
    
    // Obstacles
    let numObs = min(10, i32(uniforms.numObstacles));
    for (var i = 0; i < numObs; i++) {
        var boxNorm = vec3<f32>(0.0);
        let center = uniforms.obstacleCenters[i].xyz;
        let size = uniforms.obstacleSizesAndColors[i].xyz;
        let colorId = uniforms.obstacleSizesAndColors[i].w;
        
        let boxMin = center - size;
        let boxMax = center + size;
        
        let tBox = intersect_box(ray, boxMin, boxMax, &boxNorm);
        if tBox > 0.0 && tBox < hit.dist {
            var boxCol = matWhite.color;
            var boxMetal = 0.0;
            var boxRough = 1.0;
            
            if colorId < 0.5 { boxCol = matRed.color; }
            else if colorId < 1.5 { boxCol = matGreen.color; }
            else if colorId < 2.5 { boxCol = matMetal.color; boxMetal = matMetal.metallic; boxRough = matMetal.roughness; }
            
            hit = Hit(tBox, boxNorm, Material(boxCol, vec3<f32>(0.0), boxRough, boxMetal));
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
    
    let shadowRay = Ray(hitPoint + hit.normal * 1e-4, lightDir);
    let shadowHit = get_scene_intersection(shadowRay);
    
    var color = vec3<f32>(0.0);
    
    if hit.mat.metallic > 0.5 {
        // Reflection ray
        let reflectDir = reflect(ray.direction, hit.normal);
        let fuzz = random_hemisphere_cosine(hit.normal) * hit.mat.roughness;
        let finalReflectDir = normalize(reflectDir + fuzz);
        
        // Prevent tracing below the surface
        if dot(finalReflectDir, hit.normal) > 0.0 {
            let reflectRay = Ray(hitPoint + hit.normal * 1e-4, finalReflectDir);
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
                        color += hit.mat.color * reflectHit.mat.color * (rNDotL * 1.5 + 0.1);
                    } else {
                        color += hit.mat.color * reflectHit.mat.color * 0.1;
                    }
                }
            }
        }
        
        // Add direct specular
        if dot(shadowHit.mat.emission, shadowHit.mat.emission) > 0.0 {
            let viewDir = normalize(-ray.direction);
            let halfVector = normalize(lightDir + viewDir);
            let nDotH = max(0.0, dot(hit.normal, halfVector));
            let spec = pow(nDotH, 1.0 / max(0.01, hit.mat.roughness));
            color += hit.mat.color * spec * 2.0;
        }
        
    } else {
        // Diffuse
        if dot(shadowHit.mat.emission, shadowHit.mat.emission) > 0.0 {
            let nDotL = max(0.0, dot(hit.normal, lightDir));
            color += hit.mat.color * nDotL * 1.5; 
        }
    }
    
    // Ambient light
    color += hit.mat.color * 0.1;
    
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
