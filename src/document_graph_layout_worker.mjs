import { parentPort } from "node:worker_threads";
import { forceCenter, forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY } from "d3-force";

function deterministicSeed(value = "") {
  let hash = 2166136261;
  for (const character of String(value)) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function initialPoint(id = "", index = 0, total = 1) {
  const seed = deterministicSeed(id);
  const angle = ((seed % 3600) / 3600) * Math.PI * 2;
  const ring = 60 + ((seed >>> 8) % 7) * 22 + (index / Math.max(1, total)) * 24;
  return { x: Math.cos(angle) * ring, y: Math.sin(angle) * ring };
}

function layoutGraph(payload = {}) {
  const rawNodes = Array.isArray(payload.nodes) ? payload.nodes : [];
  const rawEdges = Array.isArray(payload.edges) ? payload.edges : [];
  const nodes = rawNodes.map((node, index) => ({
    id: node.id,
    radius: Math.max(4, Number(node.radius) || 7),
    ...initialPoint(node.id, index, rawNodes.length),
  }));
  const nodeIds = new Set(nodes.map((node) => node.id));
  const links = rawEdges
    .filter((edge) => nodeIds.has(edge.from) && nodeIds.has(edge.to))
    .map((edge) => ({ source: edge.from, target: edge.to }));
  const simulation = forceSimulation(nodes)
    .alphaDecay(0.045)
    .velocityDecay(0.42)
    .force("charge", forceManyBody().strength((node) => -52 - node.radius * 5).distanceMax(560))
    .force("link", forceLink(links).id((node) => node.id).distance(74).strength(0.16))
    .force("collide", forceCollide().radius((node) => node.radius + 5).iterations(2))
    .force("center", forceCenter(0, 0))
    .force("x", forceX(0).strength(0.018))
    .force("y", forceY(0).strength(0.018))
    .stop();
  for (let index = 0; index < 180; index += 1) simulation.tick();
  const xs = nodes.map((node) => node.x);
  const ys = nodes.map((node) => node.y);
  const minX = Math.min(...xs, -1);
  const maxX = Math.max(...xs, 1);
  const minY = Math.min(...ys, -1);
  const maxY = Math.max(...ys, 1);
  const width = Math.max(1, maxX - minX);
  const height = Math.max(1, maxY - minY);
  return nodes.map((node) => ({
    id: node.id,
    x: Number(((node.x - minX) / width).toFixed(6)),
    y: Number(((node.y - minY) / height).toFixed(6)),
  }));
}

parentPort?.on("message", (message = {}) => {
  try {
    parentPort.postMessage({ id: message.id, ok: true, positions: layoutGraph(message.payload) });
  } catch (error) {
    parentPort.postMessage({ id: message.id, ok: false, error: error.message });
  }
});
