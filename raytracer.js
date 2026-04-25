export const wgslSource = `
struct Uniforms {
    lightPos: vec3<f32>,
    frameCounter: f32,
    resolution: vec2<f32>,
    cameraPos: vec3<f32>,
    cameraDir: vec3<f32>,
    renderMode: f32,
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
    let tFloor = intersect_plane(ray, vec3<f32>(0.0, 1.0, 0.0), 0.0);
    if tFloor > 0.0 && tFloor < hit.dist { hit = Hit(tFloor, vec3<f32>(0.0, 1.0, 0.0), matWhite); }
    
    // Ceiling
    let tCeil = intersect_plane(ray, vec3<f32>(0.0, -1.0, 0.0), 2.0);
    if tCeil > 0.0 && tCeil < hit.dist { hit = Hit(tCeil, vec3<f32>(0.0, -1.0, 0.0), matWhite); }
    
    // Back wall
    let tBack = intersect_plane(ray, vec3<f32>(0.0, 0.0, -1.0), 1.0);
    if tBack > 0.0 && tBack < hit.dist { hit = Hit(tBack, vec3<f32>(0.0, 0.0, -1.0), matWhite); }
    
    // Left wall (Red)
    let tLeft = intersect_plane(ray, vec3<f32>(1.0, 0.0, 0.0), 1.0);
    if tLeft > 0.0 && tLeft < hit.dist { hit = Hit(tLeft, vec3<f32>(1.0, 0.0, 0.0), matRed); }
    
    // Right wall (Green)
    let tRight = intersect_plane(ray, vec3<f32>(-1.0, 0.0, 0.0), 1.0);
    if tRight > 0.0 && tRight < hit.dist { hit = Hit(tRight, vec3<f32>(-1.0, 0.0, 0.0), matGreen); }
    
    // Tall box
    var boxNorm = vec3<f32>(0.0);
    // Apply some rotation manually by rotating ray inverse
    let rotY = 0.3;
    let s = sin(rotY); let c = cos(rotY);
    var rBox = ray;
    rBox.origin.x = ray.origin.x * c - ray.origin.z * s;
    rBox.origin.z = ray.origin.x * s + ray.origin.z * c;
    rBox.direction.x = ray.direction.x * c - ray.direction.z * s;
    rBox.direction.z = ray.direction.x * s + ray.direction.z * c;
    // Shift origin back to box center
    rBox.origin -= vec3<f32>(-0.3, 0.0, 0.3);
    
    let tTall = intersect_box(rBox, vec3<f32>(-0.3, 0.0, -0.3), vec3<f32>(0.3, 1.2, 0.3), &boxNorm);
    if tTall > 0.0 && tTall < hit.dist { 
        // rotate normal back
        var worldNorm = boxNorm;
        worldNorm.x = boxNorm.x * c + boxNorm.z * s;
        worldNorm.z = -boxNorm.x * s + boxNorm.z * c;
        hit = Hit(tTall, normalize(worldNorm), matWhite); 
    }
    
    // Sphere
    let tSphere = intersect_sphere(ray, vec3<f32>(0.4, 0.3, -0.3), 0.3);
    if tSphere > 0.0 && tSphere < hit.dist {
        let norm = normalize((ray.origin + ray.direction * tSphere) - vec3<f32>(0.4, 0.3, -0.3));
        hit = Hit(tSphere, norm, matMetal);
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
    
    // Cast shadow ray
    let lightDir = normalize(uniforms.lightPos - hitPoint);
    let shadowRay = Ray(hitPoint + hit.normal * 1e-4, lightDir);
    let shadowHit = get_scene_intersection(shadowRay);
    
    var color = vec3<f32>(0.0);
    // If shadow ray hits the light, we're not in shadow
    if dot(shadowHit.mat.emission, shadowHit.mat.emission) > 0.0 {
        let nDotL = max(0.0, dot(hit.normal, lightDir));
        
        if hit.mat.metallic > 0.5 {
            // Simple specular
            let viewDir = normalize(-ray.direction);
            let halfVector = normalize(lightDir + viewDir);
            let nDotH = max(0.0, dot(hit.normal, halfVector));
            let spec = pow(nDotH, 1.0 / max(0.01, hit.mat.roughness));
            color = hit.mat.color * spec * 2.0; 
        } else {
            // Diffuse
            color = hit.mat.color * nDotL * 1.5; 
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
    if uniforms.renderMode <= 0.5 && uniforms.frameCounter > 0.0 {
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
