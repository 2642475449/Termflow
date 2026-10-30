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

  vec2 vortex(vec2 point, vec2 centre, float radius, float spin) {
    vec2 offset = point - centre;
    float angle = exp(-dot(offset, offset) / (radius * radius)) * spin;
    float sine = sin(angle);
    float cosine = cos(angle);
    return centre + mat2(cosine, -sine, sine, cosine) * offset;
  }

  void main() {
    vec2 uv = gl_FragCoord.xy / uResolution;
    float aspect = uResolution.x / uResolution.y;
    float time = uTime * 0.48;
    vec2 point = uv * vec2(aspect, 1.0) * 1.62;

    // 不同尺度的旋涡叠在缓慢的底流上，让纹理卷曲、分叉，而非周期性排列。
    point = vortex(point, vec2(aspect * 0.67, 0.58) * 1.62,
      1.38, 1.05 + 0.38 * sin(time * 0.31));
    point = vortex(point, vec2(aspect * 0.88, 0.22) * 1.62,
      0.72, -1.4 + 0.32 * cos(time * 0.24));

    vec2 flow = vec2(
      fbm(point + time * vec2(0.24, 0.08)),
      fbm(point + time * vec2(-0.16, 0.2) + 5.2)
    );
    vec2 eddy = vec2(
      fbm(point + 2.45 * flow + time * vec2(0.13, -0.18) + 1.7),
      fbm(point + 2.45 * flow + time * vec2(-0.1, 0.15) + 8.3)
    );
    float cloud = fbm(point + 3.1 * eddy);
    float ink = cloud + 0.42 * eddy.x + 0.18 * flow.y;
    float darkSurface = 1.0 - smoothstep(0.16, 0.4,
      dot(uBaseColor, vec3(0.2126, 0.7152, 0.0722)));
    vec3 radiance = min(vec3(1.0), uHighlightColor * (1.0 + darkSurface * 0.28));

    vec3 fluid = mix(uPaleColor, uCobaltColor, smoothstep(0.2, 0.68, cloud));
    fluid = mix(fluid, uVividColor, smoothstep(0.45, 0.88, flow.x) * 0.72);
    fluid = mix(fluid, uDeepColor, smoothstep(0.46, 0.89, eddy.y) * 0.84);

    // 大片乳白雾气、柔亮的卷边与细密光脉分开着色，保留流体内部的深度。
    float pearl = 1.0 - smoothstep(0.035, 0.17, abs(ink - 0.76));
    fluid = mix(fluid, radiance, pearl * 0.78);
    float veinDistance = abs(sin(ink * 11.5 + flow.x * 0.9));
    float veinMask = smoothstep(0.27, 0.72, eddy.x) * smoothstep(0.26, 0.64, cloud);
    float filament = (1.0 - smoothstep(0.04, 0.24, veinDistance)) * veinMask;
    float aura = (1.0 - smoothstep(0.1, 0.58, veinDistance)) * veinMask;
    fluid = mix(fluid, uPaleColor, aura * 0.2);
    fluid = mix(fluid, radiance, filament * 0.44);

    float reveal = uv.x + 0.2 * (flow.y - 0.5) + 0.14 * (eddy.x - 0.5);
    float compact = 1.0 - smoothstep(1.7, 3.0, aspect);
    float colourZone = smoothstep(mix(0.16, 0.5, compact), mix(0.9, 1.03, compact), reveal);
    float density = smoothstep(0.2, 0.82, cloud + 0.3 * eddy.x);
    float pigment = clamp(colourZone * (0.3 + 0.94 * density), 0.0, 1.0);
    float rightDepth = smoothstep(0.6, 1.0, uv.x + 0.12 * eddy.y);
    fluid = mix(fluid, uDeepColor, rightDepth * 0.3 * (1.0 - pearl * 0.5));

    vec3 colour = mix(uBaseColor, fluid, pigment);
    // 微弱的静态颗粒只用于消除平滑色阶，不随时间闪烁。
    colour += (hash(gl_FragCoord.xy) - 0.5) * 0.003 * pigment;
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
  preserveDrawingBuffer = false,
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
    let previousFrame = performance.now();
    let previousDraw = 0;
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
      const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
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
        flowTime += delta * 0.42;
      }

      gl.useProgram(program);
      gl.uniform2f(resolution, canvas.width, canvas.height);
      gl.uniform1f(time, flowTime);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      canvas.style.visibility = "visible";

      if (shouldAnimate) {
        animationFrame = window.requestAnimationFrame(draw);
      }
    };

    const restart = () => {
      window.cancelAnimationFrame(animationFrame);
      previousFrame = performance.now();
      previousDraw = 0;
      if (isVisible) draw(previousFrame);
    };

    const handleThemeChange = () => {
      if (palette) return;
      const currentPalette = readAboutFlowPalette();
      if (!currentPalette) return;
      applyPalette(currentPalette);
      restart();
    };

    const handleDocumentVisibilityChange = () => {
      if (document.hidden) {
        window.cancelAnimationFrame(animationFrame);
      } else {
        restart();
      }
    };

    // 静态模式也要在调整大小后重绘，否则 WebGL 缓冲区清空后会留下黑色背景。
    const resizeObserver = new ResizeObserver(restart);
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
    applyPalette(initialPalette);
    restart();

    return () => {
      window.cancelAnimationFrame(animationFrame);
      resizeObserver.disconnect();
      visibilityObserver.disconnect();
      themeObserver?.disconnect();
      motionQuery.removeEventListener("change", restart);
      document.removeEventListener("visibilitychange", handleDocumentVisibilityChange);
      gl.deleteBuffer(buffer);
      gl.deleteProgram(program);
    };
  }, [animate, palette, preserveDrawingBuffer]);

  return (
    <div
      aria-hidden="true"
      className="app-about-flow-backdrop pointer-events-none absolute inset-0 overflow-hidden"
    >
      <canvas ref={canvasRef} className="app-about-flow-canvas absolute inset-0 h-full w-full" />
    </div>
  );
}
