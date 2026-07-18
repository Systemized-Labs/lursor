import { useCallback, useEffect, useRef, useState } from "react"

import { cn } from "@/lib/utils"
import { drawSprite, type PixelSprite } from "./sprite"

/**
 * A tiny pixel duck-hunt game. Ducks fly across the sky at varying speeds and
 * heights; click/tap to shoot. Limited shots per round; ducks that escape cost a
 * life. Three lives. Hit ducks spin and fall. Round ends → tap to restart.
 */

const DUCK_WING_UP: PixelSprite = [
  "00111100",
  "01111110",
  "11111111",
  "01111110",
  "00111100",
  "00011000",
  "00011000",
]
const DUCK_WING_DOWN: PixelSprite = [
  "00000000",
  "00000000",
  "11111111",
  "11111110",
  "01111100",
  "00111100",
  "00011000",
  "00011000",
]
const DUCK_FALL: PixelSprite = [
  "00000000",
  "00111100",
  "01111110",
  "00111100",
  "00011000",
  "00011000",
]

const REED: PixelSprite = [
  "0010",
  "0110",
  "0010",
  "0110",
  "0010",
  "0110",
  "0010",
]

const CLOUD: PixelSprite = [
  "0011111000",
  "0111111110",
  "1111111111",
  "0111111100",
]

const SHOT_SPLASH: PixelSprite = [
  "01010",
  "10001",
  "00100",
  "10001",
  "01010",
]

type Duck = {
  x: number
  y: number
  vx: number
  wing: number
  wingTimer: number
  hit: boolean
  vy: number
  spin: number
  dead: boolean
}

type Splash = { x: number; y: number; life: number }

type GameState = {
  width: number
  height: number
  px: number
  groundY: number
  ducks: Duck[]
  splashes: Splash[]
  clouds: { x: number; y: number; px: number }[]
  spawnTimer: number
  shots: number
  score: number
  lives: number
  running: boolean
  over: boolean
  pointerX: number
  pointerY: number
}

const MAX_SHOTS = 10
const START_LIVES = 3

function spawnDuck(state: GameState) {
  const fromLeft = Math.random() > 0.5
  const speed = 60 + Math.random() * 80
  const yMin = state.px * 3
  const yMax = state.groundY - state.px * 8
  state.ducks.push({
    x: fromLeft ? -20 : state.width + 20,
    y: yMin + Math.random() * (yMax - yMin),
    vx: fromLeft ? speed : -speed,
    wing: 0,
    wingTimer: 0,
    hit: false,
    vy: 0,
    spin: 0,
    dead: false,
  })
}

export default function DuckHuntGame({ className }: { className?: string }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const fgProbeRef = useRef<HTMLSpanElement | null>(null)
  const mutedProbeRef = useRef<HTMLSpanElement | null>(null)
  const accentProbeRef = useRef<HTMLSpanElement | null>(null)
  const stateRef = useRef<GameState | null>(null)
  const rafRef = useRef<number | null>(null)
  const colorsRef = useRef({ fg: "#e5e7eb", muted: "#9ca3af", accent: "#3b82f6" })

  const [score, setScore] = useState(0)
  const [shots, setShots] = useState(MAX_SHOTS)
  const [lives, setLives] = useState(START_LIVES)
  const [over, setOver] = useState(false)
  const [started, setStarted] = useState(false)

  const start = useCallback(() => {
    const s = stateRef.current
    if (!s) return
    s.running = true
    s.over = false
    s.ducks = []
    s.splashes = []
    s.shots = MAX_SHOTS
    s.score = 0
    s.lives = START_LIVES
    s.spawnTimer = 0.3
    setOver(false)
    setStarted(true)
    setScore(0)
    setShots(MAX_SHOTS)
    setLives(START_LIVES)
  }, [])

  const fire = useCallback((x: number, y: number) => {
    const s = stateRef.current
    if (!s || !s.running || s.over) return
    if (s.shots <= 0) return
    s.shots -= 1
    setShots(s.shots)
    s.splashes.push({ x, y, life: 0.25 })
    // Hit test: check ducks front-to-back (last drawn = topmost).
    for (let i = s.ducks.length - 1; i >= 0; i--) {
      const d = s.ducks[i]
      if (d.hit) continue
      const dw = 8 * s.px
      const dh = 8 * s.px
      if (x >= d.x && x <= d.x + dw && y >= d.y && y <= d.y + dh) {
        d.hit = true
        d.vx = 0
        d.vy = 0
        d.wingTimer = 0
        s.score += 1
        setScore(s.score)
        break
      }
    }
    // If out of shots and no live ducks remain, end round.
    if (s.shots <= 0) {
      const liveDucks = s.ducks.filter((d) => !d.hit && !d.dead)
      if (liveDucks.length === 0) {
        s.over = true
        setOver(true)
      }
    }
  }, [])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext("2d")
    if (!ctx) return

    const state: GameState = {
      width: 0,
      height: 0,
      px: 2,
      groundY: 0,
      ducks: [],
      splashes: [],
      clouds: [],
      spawnTimer: 0,
      shots: MAX_SHOTS,
      score: 0,
      lives: START_LIVES,
      running: false,
      over: false,
      pointerX: 0,
      pointerY: 0,
    }
    stateRef.current = state

    const readColors = () => {
      if (fgProbeRef.current) colorsRef.current.fg = getComputedStyle(fgProbeRef.current).color
      if (mutedProbeRef.current) colorsRef.current.muted = getComputedStyle(mutedProbeRef.current).color
      if (accentProbeRef.current) colorsRef.current.accent = getComputedStyle(accentProbeRef.current).color
    }

    const resize = () => {
      const dpr = window.devicePixelRatio || 1
      const rect = canvas.getBoundingClientRect()
      state.width = rect.width
      state.height = rect.height
      canvas.width = Math.round(rect.width * dpr)
      canvas.height = Math.round(rect.height * dpr)
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      state.px = Math.max(2, Math.floor(rect.height / 30))
      state.groundY = rect.height - state.px * 5
      if (state.clouds.length === 0 && rect.width > 0) {
        state.clouds = [
          { x: rect.width * 0.25, y: state.px * 2, px: state.px * 1.2 },
          { x: rect.width * 0.65, y: state.px * 1.5, px: state.px * 0.9 },
        ]
      }
    }

    readColors()
    resize()

    const ro = new ResizeObserver(resize)
    ro.observe(canvas)
    const mo = new MutationObserver(readColors)
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style"] })

    let last = 0
    const loop = (t: number) => {
      if (!last) last = t
      const dt = Math.min(0.05, (t - last) / 1000)
      last = t
      const s = state
      const { fg, muted, accent } = colorsRef.current

      if (s.running && !s.over) {
        s.spawnTimer -= dt
        if (s.spawnTimer <= 0 && s.ducks.length < 4) {
          spawnDuck(s)
          s.spawnTimer = 0.8 + Math.random() * 1.4
        }

        for (const d of s.ducks) {
          if (d.hit) {
            // Falling duck.
            d.vy += 600 * dt
            d.y += d.vy * dt
            d.wingTimer += dt
            d.spin += dt * 8
            if (d.y >= s.groundY - s.px * 2) {
              d.dead = true
            }
          } else {
            d.x += d.vx * dt
            d.wingTimer += dt
            if (d.wingTimer > 0.18) {
              d.wingTimer = 0
              d.wing = d.wing ? 0 : 1
            }
            // Escaped off-screen.
            if ((d.vx > 0 && d.x > s.width + 20) || (d.vx < 0 && d.x < -40)) {
              d.dead = true
              s.lives -= 1
              setLives(s.lives)
              if (s.lives <= 0) {
                s.over = true
                setOver(true)
              }
            }
          }
        }
        s.ducks = s.ducks.filter((d) => !d.dead)

        // Drift clouds slowly.
        for (const c of s.clouds) c.x -= 12 * dt
        s.clouds = s.clouds.filter((c) => c.x > -CLOUD[0].length * c.px)
        if (s.clouds.length < 2 && Math.random() < 0.005) {
          s.clouds.push({ x: s.width + 20, y: s.px * (1 + Math.random() * 2), px: s.px * (0.8 + Math.random() * 0.6) })
        }

        // Fade splashes.
        for (const sp of s.splashes) sp.life -= dt
        s.splashes = s.splashes.filter((sp) => sp.life > 0)

        // End round if out of shots and no live ducks.
        if (s.shots <= 0 && s.ducks.filter((d) => !d.hit).length === 0) {
          s.over = true
          setOver(true)
        }
      }

      // ---- Render ----
      ctx.clearRect(0, 0, s.width, s.height)

      // Clouds (dim background).
      ctx.globalAlpha = 0.3
      ctx.fillStyle = muted
      for (const c of s.clouds) drawSprite(ctx, CLOUD, c.x, c.y, c.px)
      ctx.globalAlpha = 1

      // Reeds at the bottom (ground band).
      ctx.fillStyle = muted
      ctx.fillRect(0, s.groundY, s.width, s.px * 5)
      ctx.fillStyle = fg
      ctx.globalAlpha = 0.7
      for (let x = s.px; x < s.width; x += s.px * 4) {
        drawSprite(ctx, REED, x, s.groundY - REED.length * s.px + s.px * 2, s.px)
      }
      ctx.globalAlpha = 1

      // Ducks.
      for (const d of s.ducks) {
        ctx.save()
        const dw = 8 * s.px
        if (d.hit) {
          // Translate to center, spin, draw fall sprite.
          ctx.translate(d.x + dw / 2, d.y + dw / 2)
          ctx.rotate(d.spin)
          ctx.translate(-(d.x + dw / 2), -(d.y + dw / 2))
          ctx.fillStyle = fg
          drawSprite(ctx, DUCK_FALL, d.x, d.y, s.px)
        } else {
          ctx.fillStyle = fg
          const sprite = d.wing ? DUCK_WING_DOWN : DUCK_WING_UP
          drawSprite(ctx, sprite, d.x, d.y, s.px)
        }
        ctx.restore()
      }

      // Shot splashes.
      ctx.fillStyle = accent
      for (const sp of s.splashes) {
        ctx.globalAlpha = sp.life / 0.25
        drawSprite(ctx, SHOT_SPLASH, sp.x - 2.5 * s.px, sp.y - 2.5 * s.px, s.px)
      }
      ctx.globalAlpha = 1

      // Crosshair at pointer.
      if (s.running && !s.over && s.pointerX >= 0) {
        ctx.strokeStyle = accent
        ctx.lineWidth = Math.max(1, s.px / 2)
        ctx.globalAlpha = 0.8
        const cx = s.pointerX
        const cy = s.pointerY
        const r = s.px * 3
        ctx.beginPath()
        ctx.arc(cx, cy, r, 0, Math.PI * 2)
        ctx.stroke()
        ctx.beginPath()
        ctx.moveTo(cx - r * 1.6, cy)
        ctx.lineTo(cx - r * 0.5, cy)
        ctx.moveTo(cx + r * 0.5, cy)
        ctx.lineTo(cx + r * 1.6, cy)
        ctx.moveTo(cx, cy - r * 1.6)
        ctx.lineTo(cx, cy - r * 0.5)
        ctx.moveTo(cx, cy + r * 0.5)
        ctx.lineTo(cx, cy + r * 1.6)
        ctx.stroke()
        ctx.globalAlpha = 1
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

  const handleClick = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const s = stateRef.current
      if (!s) return
      if (!s.running || s.over) {
        start()
        return
      }
      const rect = e.currentTarget.getBoundingClientRect()
      fire(e.clientX - rect.left, e.clientY - rect.top)
    },
    [fire, start],
  )

  const handleTouch = useCallback(
    (e: React.TouchEvent<HTMLCanvasElement>) => {
      e.preventDefault()
      const s = stateRef.current
      if (!s) return
      const rect = e.currentTarget.getBoundingClientRect()
      const touch = e.touches[0]
      const x = touch.clientX - rect.left
      const y = touch.clientY - rect.top
      s.pointerX = x
      s.pointerY = y
      if (!s.running || s.over) {
        start()
        return
      }
      fire(x, y)
    },
    [fire, start],
  )

  const handleMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const s = stateRef.current
    if (!s) return
    const rect = e.currentTarget.getBoundingClientRect()
    s.pointerX = e.clientX - rect.left
    s.pointerY = e.clientY - rect.top
  }, [])

  // R restarts after game over.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null
      const typing =
        target &&
        (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)
      if (typing) return
      if (e.key === "r" || e.key === "R") {
        const s = stateRef.current
        if (s && s.over) start()
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [start])

  return (
    <div
      className={cn(
        "relative w-full overflow-hidden rounded-xl border border-border/60 bg-muted/30",
        className,
      )}
    >
      <span ref={fgProbeRef} className="pointer-events-none absolute text-foreground opacity-0" />
      <span ref={mutedProbeRef} className="pointer-events-none absolute text-muted-foreground opacity-0" />
      <span ref={accentProbeRef} className="pointer-events-none absolute text-primary opacity-0" />

      <canvas
        ref={canvasRef}
        onClick={handleClick}
        onTouchStart={handleTouch}
        onMouseMove={handleMove}
        onMouseLeave={() => {
          const s = stateRef.current
          if (s) {
            s.pointerX = -1
            s.pointerY = -1
          }
        }}
        className="block h-full w-full cursor-crosshair touch-none"
      />

      <div className="pointer-events-none absolute left-2 top-1.5 flex items-center gap-2 text-[11px] tabular-nums font-medium text-muted-foreground">
        <span>Score {score}</span>
        <span>·</span>
        <span>{shots} shots</span>
        <span>·</span>
        <span>{"♥".repeat(Math.max(0, lives))}</span>
      </div>

      {(!started || over) && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <span className="rounded-full bg-background/70 px-3 py-1 text-[11px] font-medium text-muted-foreground backdrop-blur-sm">
            {over ? `Round over — ${score} hits. Tap or R to replay` : "Tap to start shooting"}
          </span>
        </div>
      )}
    </div>
  )
}
