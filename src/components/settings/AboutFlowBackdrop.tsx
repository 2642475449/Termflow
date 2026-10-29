import { useEffect, useRef } from "react";

const ABOUT_FLOW_VERTEX_SHADER = `
  attribute vec2 aPosition;

  void main() {
    gl_Position = vec4(aPosition, 0.0, 1.0);
  }
`;

const ABOUT_FLOW_FRAGMENT_SHADER = `
  precision highp float;

  uniform vec2 uResolution;
  uniform float uTime;
  uniform float uEnergy;
  uniform vec3 uBaseColor;
  uniform vec3 uPaleColor;
  uniform vec3 uVividColor;
  uniform vec3 uCobaltColor;
  uniform vec3 uDeepColor;
  uniform vec3 uHighlightColor;

  float hash(vec2 point) {
    point = fract(point * vec2(123.34, 456.21));
    point += dot(point, point + 45.32);
    return fract(point.x * point.y);
  }

  float noise(vec2 point) {
    vec2 cell = floor(point);
    vec2 local = fract(point);
    local = local * local * (3.0 - 2.0 * local);

    return mix(
      mix(hash(cell), hash(cell + vec2(1.0, 0.0)), local.x),
      mix(hash(cell + vec2(0.0, 1.0)), hash(cell + vec2(1.0, 1.0)), local.x),
      local.y
    );
  }

  float fbm(vec2 point) {
    float value = 0.0;
    float amplitude = 0.56;
    mat2 rotation = mat2(0.8, 0.6, -0.6, 0.8);

    for (int index = 0; index < 5; index++) {
      value += amplitude * noise(point);
      point = rotation * point * 2.0 + 3.7;
      amplitude *= 0.5;
    }

    return value;
  }

  void main() {
    vec2 uv = gl_FragCoord.xy / uResolution;
    vec2 point = uv * vec2(uResolution.x / uResolution.y, 1.0) * 1.62;
    float time = uTime;

    vec2 flow = vec2(
      fbm(point + time * vec2(0.58, 0.18)),
      fbm(point + time * vec2(-0.38, 0.48) + 5.2)
    );
    vec2 eddy = vec2(
      fbm(point + 2.25 * flow + time * vec2(0.31, -0.42) + 1.7),
      fbm(point + 2.25 * flow + time * vec2(-0.22, 0.34) + 8.3)
    );
    float cloud = fbm(point + 2.55 * eddy);

    vec3 fluid = mix(uPaleColor, uCobaltColor, smoothstep(0.18, 0.64, cloud));
    fluid = mix(fluid, uVividColor, smoothstep(0.48, 0.9, flow.x));
    fluid = mix(fluid, uDeepColor, smoothstep(0.58, 0.94, eddy.y));

    float folded = abs((cloud + 0.44 * eddy.x + 0.18 * flow.y) - 0.73);
    float vein = 1.0 - smoothstep(0.055, 0.2, folded);
    fluid = mix(fluid, uHighlightColor, vein * 0.62);
    fluid += 0.14 * eddy.x * uPaleColor;
    fluid = mix(fluid, fluid * fluid * 1.32 + fluid * 0.1, uEnergy * 0.48);

    // Preserve a clean reading area on the left while avoiding a straight transition boundary.
    float transitionWarp = uv.x + 0.22 * (flow.y - 0.5) + 0.12 * (eddy.x - 0.5);
    float colourZone = smoothstep(0.18, 0.92, transitionWarp);
    float density = smoothstep(0.22, 0.82, cloud + 0.28 * eddy.x);
    float pigment = clamp(colourZone * (0.28 + 0.88 * density), 0.0, 1.0);
    float rightDepth = smoothstep(0.58, 1.0, uv.x + 0.1 * eddy.y);
    fluid = mix(fluid, uDeepColor, rightDepth * 0.34);

    vec3 colour = mix(uBaseColor, fluid, pigment);
    float topGlass = smoothstep(0.56, 1.0, uv.y) * (1.0 - pigment * 0.7);
    colour = mix(colour, uBaseColor, topGlass * 0.34);

    gl_FragColor = vec4(colour, 1.0);
  }
`;

export type AboutFlowRgb = readonly [number, number, number];

export type AboutFlowPalette = {
  base: AboutFlowRgb;
  pale: AboutFlowRgb;
  vivid: AboutFlowRgb;
  cobalt: AboutFlowRgb;
  deep: AboutFlowRgb;
  highlight: AboutFlowRgb;
};

export type AboutFlowHexPalette = {
  base: string;
  pale: string;
  vivid: string;
  cobalt: string;
  deep: string;
  highlight: string;
};

const parseAboutFlowColor = (value: string): AboutFlowRgb | null => {
  const match = /^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(value.trim());
  if (!match) return null;

  return [
    Number.parseInt(match[1], 16) / 255,
    Number.parseInt(match[2], 16) / 255,
    Number.parseInt(match[3], 16) / 255,
  ];
};

const readAboutFlowPalette = (): AboutFlowPalette | null => {
  const styles = getComputedStyle(document.documentElement);
  const readColor = (name: string) => parseAboutFlowColor(styles.getPropertyValue(name));
  const base = readColor("--cs-about-flow-base");
  const pale = readColor("--cs-about-flow-pale");
  const vivid = readColor("--cs-about-flow-vivid");
  const cobalt = readColor("--cs-about-flow-cobalt");
  const deep = readColor("--cs-about-flow-deep");
  const highlight = readColor("--cs-about-flow-highlight");

  if (!base || !pale || !vivid || !cobalt || !deep || !highlight) return null;
  return { base, pale, vivid, cobalt, deep, highlight };
};

const parseAboutFlowPalette = (palette: AboutFlowHexPalette): AboutFlowPalette | null => {
  const base = parseAboutFlowColor(palette.base);
  const pale = parseAboutFlowColor(palette.pale);
  const vivid = parseAboutFlowColor(palette.vivid);
  const cobalt = parseAboutFlowColor(palette.cobalt);
  const deep = parseAboutFlowColor(palette.deep);
  const highlight = parseAboutFlowColor(palette.highlight);

  if (!base || !pale || !vivid || !cobalt || !deep || !highlight) return null;
  return { base, pale, vivid, cobalt, deep, highlight };
};

export function AboutFlowBackdrop({
  palette,
  animate = true,
  preserveDrawingBuffer = true,
}: {
  palette?: AboutFlowHexPalette;
  animate?: boolean;
  preserveDrawingBuffer?: boolean;
} = {}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const card = canvas?.closest<HTMLElement>(".app-flow-surface");
    if (!canvas || !card) return;
    canvas.style.visibility = "hidden";

    const initialPalette = palette
      ? parseAboutFlowPalette(palette)
      : readAboutFlowPalette();
    if (!initialPalette) return;

    const gl = canvas.getContext("webgl", {
      alpha: false,
      antialias: false,
      depth: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer,
    });
    if (!gl) return;

    const compileShader = (type: number, source: string) => {
      const shader = gl.createShader(type);
      if (!shader) return null;

      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        gl.deleteShader(shader);
        return null;
      }
      return shader;
    };

    const vertexShader = compileShader(gl.VERTEX_SHADER, ABOUT_FLOW_VERTEX_SHADER);
    const fragmentShader = compileShader(gl.FRAGMENT_SHADER, ABOUT_FLOW_FRAGMENT_SHADER);
    if (!vertexShader || !fragmentShader) {
      if (vertexShader) gl.deleteShader(vertexShader);
      if (fragmentShader) gl.deleteShader(fragmentShader);
      return;
    }

    const program = gl.createProgram();
    if (!program) {
      gl.deleteShader(vertexShader);
      gl.deleteShader(fragmentShader);
      return;
    }

    gl.attachShader(program, vertexShader);
    gl.attachShader(program, fragmentShader);
    gl.linkProgram(program);
    gl.deleteShader(vertexShader);
    gl.deleteShader(fragmentShader);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      gl.deleteProgram(program);
      return;
    }

    const buffer = gl.createBuffer();
    if (!buffer) {
      gl.deleteProgram(program);
      return;
    }

    gl.useProgram(program);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);

    const position = gl.getAttribLocation(program, "aPosition");
    const resolution = gl.getUniformLocation(program, "uResolution");
    const time = gl.getUniformLocation(program, "uTime");
    const energy = gl.getUniformLocation(program, "uEnergy");
    const paletteUniforms = {
      base: gl.getUniformLocation(program, "uBaseColor"),
      pale: gl.getUniformLocation(program, "uPaleColor"),
      vivid: gl.getUniformLocation(program, "uVividColor"),
      cobalt: gl.getUniformLocation(program, "uCobaltColor"),
      deep: gl.getUniformLocation(program, "uDeepColor"),
      highlight: gl.getUniformLocation(program, "uHighlightColor"),
    };
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);

    const motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    const targetFrameInterval = 1000 / 30;
    let animationFrame = 0;
    let flowTime = 8.4;
    let stirEnergy = 0;
    let previousFrame = performance.now();
    let previousDraw = 0;
    let previousPointer: { x: number; y: number } | null = null;
    let isVisible = true;

    const applyPalette = (palette: AboutFlowPalette) => {
      gl.useProgram(program);
      (Object.keys(paletteUniforms) as Array<keyof AboutFlowPalette>).forEach((key) => {
        const [red, green, blue] = palette[key];
        gl.uniform3f(paletteUniforms[key], red, green, blue);
      });
    };

    const resize = () => {
      const bounds = canvas.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 1);
      const width = Math.max(1, Math.round(bounds.width * dpr));
      const height = Math.max(1, Math.round(bounds.height * dpr));
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
        gl.viewport(0, 0, width, height);
      }
    };

    const draw = (now: number) => {
      if (!isVisible) return;

      const shouldAnimate = animate && !motionQuery.matches && !document.hidden;
      if (
        shouldAnimate &&
        previousDraw > 0 &&
        now - previousDraw < targetFrameInterval
      ) {
        animationFrame = window.requestAnimationFrame(draw);
        return;
      }

      previousDraw = now;
      resize();
      const delta = Math.min((now - previousFrame) / 1000, 0.1);
      previousFrame = now;

      if (shouldAnimate) {
        stirEnergy *= Math.exp(-delta * 1.55);
        flowTime += delta * (0.25 + stirEnergy * 0.82);
      }

      gl.useProgram(program);
      gl.uniform2f(resolution, canvas.width, canvas.height);
      gl.uniform1f(time, flowTime);
      gl.uniform1f(energy, stirEnergy);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      canvas.style.visibility = "visible";

      if (shouldAnimate) {
        animationFrame = window.requestAnimationFrame(draw);
      }
    };

    const restart = () => {
      window.cancelAnimationFrame(animationFrame);
      previousFrame = performance.now();
      if (isVisible) draw(previousFrame);
    };

    const handleThemeChange = () => {
      if (palette) return;
      const currentPalette = readAboutFlowPalette();
      if (!currentPalette) return;
      applyPalette(currentPalette);
      restart();
    };

    const handlePointerMove = (event: PointerEvent) => {
      if (!animate || motionQuery.matches) return;
      if (previousPointer) {
        const distance = Math.hypot(event.clientX - previousPointer.x, event.clientY - previousPointer.y);
        stirEnergy = Math.min(1, stirEnergy + distance * 0.012);
      }
      previousPointer = { x: event.clientX, y: event.clientY };
    };

    const clearPointer = () => {
      previousPointer = null;
    };

    const handleDocumentVisibilityChange = () => {
      if (document.hidden) {
        window.cancelAnimationFrame(animationFrame);
      } else {
        restart();
      }
    };

    const resizeObserver = new ResizeObserver(resize);
    const visibilityObserver = new IntersectionObserver(([entry]) => {
      const nextVisible = entry?.isIntersecting ?? true;
      if (nextVisible === isVisible) return;

      isVisible = nextVisible;
      if (isVisible) {
        restart();
      } else {
        window.cancelAnimationFrame(animationFrame);
      }
    });
    const themeObserver = palette ? null : new MutationObserver(handleThemeChange);
    resizeObserver.observe(canvas);
    visibilityObserver.observe(card);
    themeObserver?.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    motionQuery.addEventListener("change", restart);
    document.addEventListener("visibilitychange", handleDocumentVisibilityChange);
    if (animate) {
      card.addEventListener("pointermove", handlePointerMove);
      card.addEventListener("pointerleave", clearPointer);
    }
    applyPalette(initialPalette);
    restart();

    return () => {
      window.cancelAnimationFrame(animationFrame);
      resizeObserver.disconnect();
      visibilityObserver.disconnect();
      themeObserver?.disconnect();
      motionQuery.removeEventListener("change", restart);
      document.removeEventListener("visibilitychange", handleDocumentVisibilityChange);
      card.removeEventListener("pointermove", handlePointerMove);
      card.removeEventListener("pointerleave", clearPointer);
      gl.deleteBuffer(buffer);
      gl.deleteProgram(program);
    };
  }, [animate, palette, preserveDrawingBuffer]);

  const fallbackBackground = palette
    ? `linear-gradient(104deg, ${palette.base} 0%, ${palette.pale} 48%, ${palette.vivid} 72%, ${palette.deep} 100%)`
    : undefined;

  return (
    <div
      aria-hidden="true"
      className="about-flow-backdrop pointer-events-none absolute inset-0 overflow-hidden"
      style={{ background: fallbackBackground }}
    >
      <canvas ref={canvasRef} className="about-flow-canvas absolute inset-0 h-full w-full" />
      <div
        className="about-flow-gloss"
        style={palette ? {
          background: `linear-gradient(180deg, ${palette.base}3d, transparent 38%), radial-gradient(ellipse 78% 150% at 0% 50%, ${palette.base}52, ${palette.vivid}14 48%, transparent 100%)`,
        } : undefined}
      />
    </div>
  );
}
