#version 300 es
// Fullscreen triangle. No attributes: the vertex is derived from
// gl_VertexID, so there are no buffers to bind. Draw with
// drawArrays(TRIANGLES, 0, 3).
out vec2 vNdc;
void main() {
    vNdc = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2) * 2.0 - 1.0;
    gl_Position = vec4(vNdc, 0.0, 1.0);
}
