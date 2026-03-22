import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getDataDir } from "../db/client";

const TICKS_PER_BEAT = 480;

interface MusicProfile {
  tempo: number;
  program: number;
  programLabel: string;
  rootMidi: number;
  scaleLabel: string;
  scaleIntervals: number[];
  noteBeats: number;
}

export interface GenerateMusicSketchInput {
  prompt: string;
  outputPath?: string;
  tempo?: number;
  bars?: number;
}

export interface GeneratedMusicSketch {
  prompt: string;
  outputPath: string;
  tempo: number;
  bars: number;
  program: number;
  programLabel: string;
  scale: string;
  noteCount: number;
  durationSeconds: number;
  seed: number;
}

function defaultOutputPath() {
  return join(getDataDir(), "generated-music", `aliceloop-sketch-${Date.now()}.mid`);
}

function clampInteger(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

function hashPrompt(prompt: string) {
  let hash = 2166136261;
  for (let index = 0; index < prompt.length; index += 1) {
    hash ^= prompt.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return hash >>> 0;
}

function createPrng(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function profileFromPrompt(prompt: string, explicitTempo?: number): MusicProfile {
  const normalized = prompt.toLowerCase();

  let tempo = explicitTempo ?? 96;
  let program = 0;
  let programLabel = "acoustic-grand-piano";
  let rootMidi = 60;
  let scaleLabel = "C major";
  let scaleIntervals = [0, 2, 4, 5, 7, 9, 11, 12];
  let noteBeats = 1;

  if (/\b(chill|calm|ambient|lofi|sleep|gentle)\b/.test(normalized)) {
    tempo = explicitTempo ?? 74;
    noteBeats = 2;
  }

  if (/\b(fast|energetic|dance|action|upbeat|driving)\b/.test(normalized)) {
    tempo = explicitTempo ?? 128;
    noteBeats = 0.5;
  }

  if (/\b(sad|dark|night|minor|melancholy|moody)\b/.test(normalized)) {
    rootMidi = 57;
    scaleLabel = "A minor";
    scaleIntervals = [0, 2, 3, 5, 7, 8, 10, 12];
  }

  if (/\b(pentatonic|folk|acoustic)\b/.test(normalized)) {
    scaleLabel = scaleLabel.includes("minor") ? "minor pentatonic" : "major pentatonic";
    scaleIntervals = scaleLabel.includes("minor")
      ? [0, 3, 5, 7, 10, 12]
      : [0, 2, 4, 7, 9, 12];
  }

  if (/\b(guitar|strum|acoustic guitar)\b/.test(normalized)) {
    program = 24;
    programLabel = "acoustic-guitar";
  } else if (/\b(strings|cinematic|orchestra|orchestral)\b/.test(normalized)) {
    program = 48;
    programLabel = "strings";
  } else if (/\b(retro|8-bit|arcade|chip)\b/.test(normalized)) {
    program = 80;
    programLabel = "lead-square";
    tempo = explicitTempo ?? Math.max(tempo, 118);
    noteBeats = 0.5;
  } else if (/\b(bell|music box|dream)\b/.test(normalized)) {
    program = 10;
    programLabel = "music-box";
  }

  return {
    tempo: clampInteger(tempo, 48, 180),
    program,
    programLabel,
    rootMidi,
    scaleLabel,
    scaleIntervals,
    noteBeats,
  };
}

function encodeVariableLength(value: number) {
  let buffer = value & 0x7f;
  const bytes: number[] = [];

  while ((value >>= 7) > 0) {
    buffer <<= 8;
    buffer |= (value & 0x7f) | 0x80;
  }

  while (true) {
    bytes.push(buffer & 0xff);
    if (buffer & 0x80) {
      buffer >>= 8;
      continue;
    }
    break;
  }

  return Buffer.from(bytes);
}

function midiEvent(delta: number, bytes: number[]) {
  return Buffer.concat([encodeVariableLength(delta), Buffer.from(bytes)]);
}

function metaEvent(delta: number, type: number, data: number[]) {
  return Buffer.concat([
    encodeVariableLength(delta),
    Buffer.from([0xff, type, data.length]),
    Buffer.from(data),
  ]);
}

function buildTrackChunk(events: Buffer[]) {
  const body = Buffer.concat(events);
  const header = Buffer.alloc(8);
  header.write("MTrk", 0, "ascii");
  header.writeUInt32BE(body.length, 4);
  return Buffer.concat([header, body]);
}

function buildHeaderChunk() {
  const header = Buffer.alloc(14);
  header.write("MThd", 0, "ascii");
  header.writeUInt32BE(6, 4);
  header.writeUInt16BE(0, 8);
  header.writeUInt16BE(1, 10);
  header.writeUInt16BE(TICKS_PER_BEAT, 12);
  return header;
}

function buildSketchMidi(prompt: string, profile: MusicProfile, bars: number, seed: number) {
  const random = createPrng(seed);
  const stepsPerBar = Math.max(1, Math.round(4 / profile.noteBeats));
  const totalSteps = bars * stepsPerBar;
  const durationTicks = Math.max(60, Math.round(TICKS_PER_BEAT * profile.noteBeats));
  const events: Buffer[] = [];

  const microsPerBeat = Math.round(60_000_000 / profile.tempo);
  events.push(metaEvent(0, 0x51, [
    (microsPerBeat >> 16) & 0xff,
    (microsPerBeat >> 8) & 0xff,
    microsPerBeat & 0xff,
  ]));
  events.push(metaEvent(0, 0x58, [4, 2, 24, 8]));
  events.push(midiEvent(0, [0xc0, profile.program]));

  let previousDegree = 0;
  for (let index = 0; index < totalSteps; index += 1) {
    const direction = random() > 0.5 ? 1 : -1;
    const leap = random() > 0.82 ? 2 : 1;
    const nextDegree = Math.max(
      0,
      Math.min(profile.scaleIntervals.length - 1, previousDegree + direction * leap),
    );
    const degree = index === 0 || random() > 0.7
      ? Math.floor(random() * profile.scaleIntervals.length)
      : nextDegree;
    previousDegree = degree;

    const note = profile.rootMidi + profile.scaleIntervals[degree];
    const velocity = 72 + Math.floor(random() * 28);
    events.push(midiEvent(0, [0x90, note, velocity]));
    events.push(midiEvent(durationTicks, [0x80, note, 0]));
  }

  events.push(metaEvent(0, 0x2f, []));
  return buildTrackChunk(events);
}

export function generateMusicSketch(input: GenerateMusicSketchInput): GeneratedMusicSketch {
  const prompt = input.prompt.trim();
  if (!prompt) {
    throw new Error("Music prompt is required.");
  }

  const bars = clampInteger(input.bars ?? 4, 1, 16);
  const profile = profileFromPrompt(prompt, input.tempo);
  const seed = hashPrompt(prompt);
  const midi = Buffer.concat([
    buildHeaderChunk(),
    buildSketchMidi(prompt, profile, bars, seed),
  ]);

  const outputPath = input.outputPath?.trim() || defaultOutputPath();
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, midi);

  const noteCount = bars * Math.max(1, Math.round(4 / profile.noteBeats));
  const durationSeconds = Number(((noteCount * profile.noteBeats * 60) / profile.tempo).toFixed(2));

  return {
    prompt,
    outputPath,
    tempo: profile.tempo,
    bars,
    program: profile.program,
    programLabel: profile.programLabel,
    scale: profile.scaleLabel,
    noteCount,
    durationSeconds,
    seed,
  };
}
