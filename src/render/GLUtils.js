/**
 * GLUtils.js — small helpers around raw WebGL2.
 *
 * Keeps shader compilation, program creation and buffer setup in one place so
 * the renderers can stay focused on what they draw.
 */

/**
 * Compile a shader, throwing a descriptive error on failure.
 * @param {WebGL2RenderingContext} gl
 * @param {number} type gl.VERTEX_SHADER or gl.FRAGMENT_SHADER
 * @param {string} source
 * @param {string} label used in error messages
 * @returns {WebGLShader}
 */
export function compileShader(gl, type, source, label) {
  const shader = gl.createShader(type);
  if (!shader) throw new Error(`[GL] could not create shader "${label}"`);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader) || 'unknown error';
    gl.deleteShader(shader);
    // Include the offending lines to make debugging shaders bearable.
    const numbered = source.split('\n').map((line, i) => `${String(i + 1).padStart(3)}| ${line}`).join('\n');
    throw new Error(`[GL] shader "${label}" failed to compile:\n${log}\n${numbered}`);
  }
  return shader;
}

/**
 * Compile and link a program from vertex + fragment sources.
 * @returns {WebGLProgram}
 */
export function createProgram(gl, vertexSource, fragmentSource, label) {
  const vs = compileShader(gl, gl.VERTEX_SHADER, vertexSource, `${label}.vert`);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource, `${label}.frag`);
  const program = gl.createProgram();
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  // Shaders can be deleted as soon as they are linked.
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program) || 'unknown error';
    gl.deleteProgram(program);
    throw new Error(`[GL] program "${label}" failed to link: ${log}`);
  }
  return program;
}

/**
 * Cache every active uniform location of a program.
 * @returns {{program:WebGLProgram, uniforms:Record<string,WebGLUniformLocation>}}
 */
export function createShaderProgram(gl, vertexSource, fragmentSource, label) {
  const program = createProgram(gl, vertexSource, fragmentSource, label);
  const uniforms = Object.create(null);
  const count = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < count; i++) {
    const info = gl.getActiveUniform(program, i);
    if (!info) continue;
    // Array uniforms are reported as "name[0]"; expose the bare name too.
    const name = info.name.replace(/\[0\]$/, '');
    uniforms[name] = gl.getUniformLocation(program, info.name);
  }
  return { program, uniforms };
}

/**
 * Create a vertex array object with an interleaved vertex buffer and an
 * optional index buffer.
 *
 * @param {WebGL2RenderingContext} gl
 * @param {Array<{location:number, size:number, offsetFloats:number}>} attributes
 * @param {number} strideFloats floats per vertex
 * @param {Float32Array} vertices
 * @param {Uint32Array|null} indices
 * @param {{dynamic?:boolean}} [options]
 */
export function createMeshVAO(gl, attributes, strideFloats, vertices, indices, options = {}) {
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);

  const vbo = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
  const usage = options.dynamic ? gl.DYNAMIC_DRAW : gl.STATIC_DRAW;
  gl.bufferData(gl.ARRAY_BUFFER, vertices, usage);

  const stride = strideFloats * 4;
  for (const attr of attributes) {
    gl.enableVertexAttribArray(attr.location);
    gl.vertexAttribPointer(attr.location, attr.size, gl.FLOAT, false, stride, attr.offsetFloats * 4);
  }

  let ibo = null;
  let indexCount = 0;
  if (indices && indices.length > 0) {
    ibo = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, usage);
    indexCount = indices.length;
  }

  gl.bindVertexArray(null);
  gl.bindBuffer(gl.ARRAY_BUFFER, null);

  return { vao, vbo, ibo, vertexCount: vertices.length / strideFloats, indexCount };
}

/**
 * Check for a GL error and log it with a label. Cheap enough to call at the
 * end of each render pass in debug builds.
 * @returns {boolean} true when an error was found
 */
export function checkGLError(gl, label) {
  const error = gl.getError();
  if (error !== gl.NO_ERROR) {
    console.error(`[GL] error 0x${error.toString(16)} at ${label}`);
    return true;
  }
  return false;
}

/**
 * Resize a canvas's backing store to match its CSS size and the device pixel
 * ratio, capped to keep fill rate sane on HiDPI displays.
 * @returns {{width:number, height:number, changed:boolean}}
 */
export function resizeCanvasToDisplaySize(canvas, maxPixelRatio = 2, dprOverride = null) {
  const dpr = Math.min(dprOverride ?? (window.devicePixelRatio || 1), maxPixelRatio);
  const displayWidth = Math.max(1, Math.round(canvas.clientWidth * dpr));
  const displayHeight = Math.max(1, Math.round(canvas.clientHeight * dpr));
  const changed = canvas.width !== displayWidth || canvas.height !== displayHeight;
  if (changed) {
    canvas.width = displayWidth;
    canvas.height = displayHeight;
  }
  return { width: displayWidth, height: displayHeight, changed };
}
