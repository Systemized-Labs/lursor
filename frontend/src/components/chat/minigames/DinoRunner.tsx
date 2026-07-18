import { useCallback, useEffect, useRef, useState } from "react"

import { cn } from "@/lib/utils"
import { drawSprite } from "./sprite"
/**
 * A tiny, self-contained Chrome-style dino runner — a T-rex hops over cacti.
 * Purely for fun while a goal
 * executes autonomously. Canvas-based so it stays cheap and never triggers a
 * React re-render per frame; the small React state is only for the score/game
 * banner overlay. Jump with Space / ↑ / click; the same input restarts after a
 * crash.
 */

// Pixel-art robot, facing right. 1 = filled pixel. Boxy head with visor eye
// and antenna, armoured torso with a forward arm, and two legs that alternate
// for the run cycle (or tuck together while airborne).
const RUNNER_BODY = [
  "000000000110000000000000", // antenna
  "000000001111100000000000", // head top
  "000000011001110000000000", // head + visor eye
  "000000011111110000000000", // head bottom
  "000000001111100000000000", // neck
  "000000111111111111111000", // shoulders + arm
  "000001111111111111111100", // torso top
  "000001111111111111111100", // torso mid
  "000001111111111111111000", // torso lower
  "000000111111111111110000", // waist
]
const RUNNER_LEGS_A = [
  "000000111100011110000000", // legs apart
  "000000111000011100000000",
  "000000111000011100000000",
  "000000110000001110000000", // feet
  "000001110000000111000000",
]
const RUNNER_LEGS_B = [
  "000000111100011110000000", // legs together
  "000000111000001110000000",
  "000000111000001110000000",
  "000000011100000110000000", // feet
  "000000011100000111000000",
]
const RUNNER_LEGS_JUMP = [
  "000000111100011110000000", // legs tucked
  "000000011100001110000000",
  "000000001100000110000000",
  "000000011100000111000000",
  "000000011000000011000000",
]
const RUNNER_W = 24
const RUNNER_H = RUNNER_BODY.length + RUNNER_LEGS_A.length // 15

// Cactus variants. 1 = filled pixel. A tall saguaro with two arms and a
// shorter stubby bush give the field a little variety.
const CACTUS_TALL = [
  "0011100",
  "0011100",
  "0011100",
  "1011100",
  "1011101",
  "1011101",
  "1111111",
  "0011100",
  "0011100",
  "0011100",
  "0011100",
]
const CACTUS_SHORT = [
  "01110",
  "01110",
  "11110",
  "11111",
  "01111",
  "01110",
  "01110",
]
const CACTUS_KINDS = [CACTUS_TALL, CACTUS_SHORT]

// A soft pixel cloud drifting in the background.
const CLOUD = [
  "0011111000",
  "0111111110",
  "1111111111",
  "0111111100",
]

type Obstacle = { x: number; rows: string[]; w: number; h: number; scale: number }
type Cloud = { x: number; y: number; px: number }

type GameState = {
  running: boolean
  over: boolean
  // World is measured in CSS pixels of the canvas.
  width: number
  height: number
  groundY: number
  px: number // logical pixel size for sprites
  dinoY: number // dino vertical offset from the ground baseline (0 = grounded, negative = airborne)
  vy: number
  jumps: number // impulses used since leaving the ground (0 grounded, up to 2 for the double jump)
  jumpV: number // launch velocity, sized to the canvas so the dino never flies off-screen
  ceiling: number // most-negative dinoY allowed, keeps the apex on-screen
  obstacles: Obstacle[]
  clouds: Cloud[]
  cloudTimer: number
  groundScroll: number
  spawnTimer: number
  speed: number
  score: number
  legFrame: number
  legTimer: number
}

const GRAVITY = 2600 // px/s^2
const BASE_SPEED = 220 // px/s
const MAX_SPEED = 480

export function DinoRunner({ className }: { className?: string }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const fgProbeRef = useRef<HTMLSpanElement | null>(null)
  const mutedProbeRef = useRef<HTMLSpanElement | null>(null)
  const stateRef = useRef<GameState | null>(null)
  const rafRef = useRef<number | null>(null)
  const colorsRef = useRef({ fg: "#e5e7eb", muted: "#9ca3af" })

  // Overlay state (cheap, updated at most a few times/sec, not per frame).
  const [score, setScore] = useState(0)
  const [over, setOver] = useState(false)
  const [started, setStarted] = useState(false)

  const jump = useCallback(() => {
    const s = stateRef.current
    if (!s) return
    if (s.over || !s.running) {
      // (Re)start.
      resetGame(s)
      setOver(false)
      setStarted(true)
      setScore(0)
      return
    }
    if (s.dinoY === 0) {
      // First jump off the ground.
      s.vy = s.jumpV
      s.jumps = 1
    } else if (s.jumps < 2) {
      // Airborne double jump — a slightly softer second impulse.
      s.vy = s.jumpV * 0.85
      s.jumps = 2
    }
  }, [])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext("2d")
    if (!ctx) return

    const state: GameState = {
      running: false,
      over: false,
      width: 0,
      height: 0,
      groundY: 0,
      px: 2,
      dinoY: 0,
      vy: 0,
      jumps: 0,
      jumpV: -520,
      ceiling: -120,
      obstacles: [],
      clouds: [],
      cloudTimer: 0.4,
      groundScroll: 0,
      spawnTimer: 0,
      speed: BASE_SPEED,
      score: 0,
      legFrame: 0,
      legTimer: 0,
    }
    stateRef.current = state

    const readColors = () => {
      if (fgProbeRef.current) {
        colorsRef.current.fg = getComputedStyle(fgProbeRef.current).color
      }
      if (mutedProbeRef.current) {
        colorsRef.current.muted = getComputedStyle(mutedProbeRef.current).color
      }
    }

    const resize = () => {
      const dpr = window.devicePixelRatio || 1
      const rect = canvas.getBoundingClientRect()
      state.width = rect.width
      state.height = rect.height
      canvas.width = Math.round(rect.width * dpr)
      canvas.height = Math.round(rect.height * dpr)
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      // Keep the dino to a modest fraction of the canvas height so there's
      // headroom to jump into.
      state.px = Math.max(2, Math.floor((rect.height * 0.38) / RUNNER_H))
      // Leave a small apron below the baseline for the scrolling ground texture.
      state.groundY = rect.height - state.px * 3
      // Derive the jump velocity from the space above the dino so the apex
      // always stays on-screen: apex height = v^2 / (2g).
      const dinoH = RUNNER_H * state.px
      const headroom = state.groundY - dinoH
      // A single jump reaches a bit higher now; the second (double) jump can
      // stack on top, so the ceiling clamp keeps the apex inside the canvas.
      const maxJump = Math.max(state.px * 4, Math.min(headroom * 0.7, dinoH * 1.6))
      state.jumpV = -Math.sqrt(2 * GRAVITY * maxJump)
      state.ceiling = -(headroom - state.px)

      // Seed a couple of clouds so the idle scene isn't empty.
      if (state.clouds.length === 0 && rect.width > 0) {
        const skyBottom = state.groundY - dinoH - state.px * 2
        state.clouds = [
          { x: rect.width * 0.28, y: state.px * 3, px: state.px * 1.6 },
          { x: rect.width * 0.7, y: Math.max(state.px * 3, skyBottom * 0.5), px: state.px * 1.1 },
        ]
      }
    }

    readColors()
    resize()

    const ro = new ResizeObserver(resize)
    ro.observe(canvas)

    // Refresh colors when the theme class toggles on <html>.
    const mo = new MutationObserver(readColors)
    mo.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "style"],
    })

    let last = 0
    let scoreSync = 0
    const loop = (t: number) => {
      if (!last) last = t
      const dt = Math.min(0.05, (t - last) / 1000)
      last = t

      const s = state
      if (s.running && !s.over) {
        // Physics.
        s.vy += GRAVITY * dt
        s.dinoY += s.vy * dt
        if (s.dinoY > 0) {
          // Landed.
          s.dinoY = 0
          s.vy = 0
          s.jumps = 0
        } else if (s.dinoY < s.ceiling) {
          // Hit the top of the play area — stop rising.
          s.dinoY = s.ceiling
          if (s.vy < 0) s.vy = 0
        }

        // Difficulty ramps with score.
        s.speed = Math.min(MAX_SPEED, BASE_SPEED + s.score * 0.06)

        // Legs animation.
        s.legTimer += dt
        if (s.legTimer > 0.12) {
          s.legTimer = 0
          s.legFrame = s.legFrame ? 0 : 1
        }

        // Ground texture scrolls with the world speed.
        s.groundScroll += s.speed * dt

        // Spawn obstacles with a gap large enough to always be clearable.
        s.spawnTimer -= dt
        if (s.spawnTimer <= 0) {
          const rows = CACTUS_KINDS[Math.floor(Math.random() * CACTUS_KINDS.length)]
          // Keep cacti modestly sized so a single jump always clears them.
          const scale = 0.9 + Math.random() * 0.4
          s.obstacles.push({ x: s.width + 10, rows, w: rows[0].length, h: rows.length, scale })
          // Gap in seconds; shrinks slightly with score, with a little jitter.
          const base = Math.max(0.75, 1.25 - s.score * 0.0015)
          s.spawnTimer = base + Math.random() * 0.5
        }

        // Drift and spawn background clouds (slower than the ground = parallax).
        s.cloudTimer -= dt
        if (s.cloudTimer <= 0) {
          s.cloudTimer = 2.8 + Math.random() * 3.5
          const skyBottom = s.groundY - RUNNER_H * s.px - s.px * 2
          s.clouds.push({
            x: s.width + 20,
            y: s.px * 2 + Math.random() * Math.max(s.px, skyBottom * 0.6),
            px: s.px * (1 + Math.random()),
          })
        }
        for (const c of s.clouds) c.x -= s.speed * 0.35 * dt
        s.clouds = s.clouds.filter((c) => c.x > -CLOUD[0].length * c.px)

        // Move & cull obstacles.
        for (const o of s.obstacles) o.x -= s.speed * dt
        s.obstacles = s.obstacles.filter((o) => o.x > -o.w * s.px * o.scale)

        s.score += dt * 12

        // Collision test. Hitboxes are inset from the sprite bounds so only the
        // solid mass counts, and the dino's feet rise with the jump — the key
        // fix that makes jumping actually clear obstacles.
        const dinoX = s.px * 6
        const dinoW = RUNNER_W * s.px
        const dinoH = RUNNER_H * s.px
        const dinoTop = s.groundY - dinoH + s.dinoY
        const dinoBox = {
          l: dinoX + dinoW * 0.2,
          r: dinoX + dinoW * 0.8,
          t: dinoTop + dinoH * 0.12,
          b: dinoTop + dinoH, // feet — moves up while airborne
        }
        for (const o of s.obstacles) {
          const cw = o.w * s.px * o.scale
          const chh = o.h * s.px * o.scale
          const box = {
            l: o.x + cw * 0.2,
            r: o.x + cw * 0.8,
            t: s.groundY - chh,
            b: s.groundY,
          }
          if (
            dinoBox.r > box.l &&
            dinoBox.l < box.r &&
            dinoBox.b > box.t &&
            dinoBox.t < box.b
          ) {
            s.over = true
            setOver(true)
            break
          }
        }

        // Sync the overlay score a few times per second.
        scoreSync += dt
        if (scoreSync > 0.15) {
          scoreSync = 0
          setScore(Math.floor(s.score))
        }
      }

      // ---- Render ----
      const { fg, muted } = colorsRef.current
      ctx.clearRect(0, 0, s.width, s.height)

      // Clouds (background, dimmed for depth).
      ctx.globalAlpha = 0.4
      ctx.fillStyle = muted
      for (const c of s.clouds) {
        drawSprite(ctx, CLOUD, c.x, c.y, c.px)
      }
      ctx.globalAlpha = 1

      // Ground: a solid baseline plus scrolling dashes/pebbles below it.
      const lineH = Math.max(1, Math.floor(s.px / 2))
      ctx.fillStyle = muted
      ctx.fillRect(0, s.groundY, s.width, lineH)
      ctx.globalAlpha = 0.6
      const markGap = s.px * 12
      const markW = s.px * 3
      const off = s.groundScroll % markGap
      for (let x = -off; x < s.width; x += markGap) {
        // Alternate a longer dash and a short pebble for a bit of texture.
        const long = Math.round((x + off) / markGap) % 2 === 0
        ctx.fillRect(x, s.groundY + s.px * 1.5, long ? markW : s.px, lineH)
      }
      ctx.globalAlpha = 1

      // Dino.
      const dinoX = s.px * 6
      const dinoTop = s.groundY - RUNNER_H * s.px + s.dinoY
      ctx.fillStyle = fg
      drawSprite(ctx, RUNNER_BODY, dinoX, dinoTop, s.px)
      const legs =
        s.dinoY < 0
          ? RUNNER_LEGS_JUMP
          : s.legFrame
            ? RUNNER_LEGS_B
            : RUNNER_LEGS_A
      drawSprite(ctx, legs, dinoX, dinoTop + RUNNER_BODY.length * s.px, s.px)

      // Obstacles.
      ctx.fillStyle = fg
      for (const o of s.obstacles) {
        const scaledPx = s.px * o.scale
        const oy = s.groundY - o.h * scaledPx
        drawSprite(ctx, o.rows, o.x, oy, scaledPx)
      }

      rafRef.current = requestAnimationFrame(loop)
    }

    rafRef.current = requestAnimationFrame(loop)

    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
      ro.disconnect()
      mo.disconnect()
    }
  }, [])

  // Keyboard: jump/restart on Space or ArrowUp, but never steal typing.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null
      const typing =
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable)
      if (typing) return
      if (e.code === "Space" || e.code === "ArrowUp" || e.key === " ") {
        e.preventDefault()
        jump()
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [jump])

  return (
    <div
      className={cn(
        "relative w-full overflow-hidden rounded-xl border border-border/60 bg-muted/30",
        className,
      )}
    >
      {/* Colour probes: let the canvas sample the current theme tokens. */}
      <span ref={fgProbeRef} className="pointer-events-none absolute text-foreground opacity-0" />
      <span
        ref={mutedProbeRef}
        className="pointer-events-none absolute text-muted-foreground opacity-0"
      />

      <canvas
        ref={canvasRef}
        onClick={jump}
        onTouchStart={(e) => {
          e.preventDefault()
          jump()
        }}
        className="block h-full w-full cursor-pointer touch-none"
      />

      {/* Score / state overlay. */}
      <div className="pointer-events-none absolute right-2 top-1.5 text-[11px] tabular-nums font-medium text-muted-foreground">
        {String(score).padStart(5, "0")}
      </div>

      {(!started || over) && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <span className="rounded-full bg-background/70 px-3 py-1 text-[11px] font-medium text-muted-foreground backdrop-blur-sm">
            {over ? "Game over — tap or press Space to retry" : "Tap or press Space to play"}
          </span>
        </div>
      )}
    </div>
  )
}

function resetGame(s: GameState) {
  s.running = true
  s.over = false
  s.dinoY = 0
  s.vy = 0
  s.jumps = 0
  s.obstacles = []
  s.cloudTimer = 1.5
  s.spawnTimer = 0.6
  s.speed = BASE_SPEED
  s.score = 0
  s.legFrame = 0
  s.legTimer = 0
}

export default DinoRunner
