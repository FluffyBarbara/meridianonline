/** Фоновые эффекты: снег и лёгкий параллакс. */

export function initSnow(canvas) {
  const ctx = canvas.getContext('2d');
  let w = 0, h = 0, flakes = [], raf = 0, running = false;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);

  function resize() {
    w = canvas.clientWidth; h = canvas.clientHeight;
    canvas.width = w * dpr; canvas.height = h * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function spawn(initial) {
    const depth = Math.random();
    return {
      x: Math.random() * w,
      y: initial ? Math.random() * h : -10,
      r: 0.6 + depth * 1.8,
      vy: 0.15 + depth * 0.55,
      vx: -0.1 + Math.random() * 0.25,
      a: 0.15 + depth * 0.55,
      phase: Math.random() * Math.PI * 2,
    };
  }

  function frame(t) {
    ctx.clearRect(0, 0, w, h);
    for (const f of flakes) {
      f.y += f.vy;
      f.x += f.vx + Math.sin(t / 2200 + f.phase) * 0.18;
      if (f.y > h + 10 || f.x < -10 || f.x > w + 10) Object.assign(f, spawn(false));
      ctx.globalAlpha = f.a;
      ctx.beginPath();
      ctx.arc(f.x, f.y, f.r, 0, Math.PI * 2);
      ctx.fillStyle = '#dbe8ff';
      ctx.fill();
    }
    raf = requestAnimationFrame(frame);
  }

  function start() {
    if (running) return;
    running = true;
    resize();
    if (!flakes.length) flakes = Array.from({ length: 90 }, () => spawn(true));
    raf = requestAnimationFrame(frame);
  }
  function stop() {
    running = false;
    cancelAnimationFrame(raf);
    ctx.clearRect(0, 0, w, h);
  }

  window.addEventListener('resize', () => running && resize());
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) cancelAnimationFrame(raf);
    else if (running) raf = requestAnimationFrame(frame);
  });

  return { start, stop };
}

export function initParallax(layers) {
  let tx = 0, ty = 0, cx = 0, cy = 0, raf = 0;
  window.addEventListener('mousemove', (e) => {
    tx = (e.clientX / window.innerWidth - 0.5);
    ty = (e.clientY / window.innerHeight - 0.5);
    if (!raf) raf = requestAnimationFrame(tick);
  });
  function tick() {
    cx += (tx - cx) * 0.06;
    cy += (ty - cy) * 0.06;
    for (const [el, depth] of layers) {
      if (el) el.style.transform = `translate3d(${(-cx * depth).toFixed(2)}px, ${(-cy * depth * 0.5).toFixed(2)}px, 0) scale(1.04)`;
    }
    raf = Math.abs(tx - cx) + Math.abs(ty - cy) > 0.001 ? requestAnimationFrame(tick) : 0;
  }
}
