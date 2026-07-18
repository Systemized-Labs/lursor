import { useCallback, useEffect, useRef, useState } from "react"

import { cn } from "@/lib/utils"
import { drawSprite, type PixelSprite } from "./sprite"

/**
 * A tiny single-button pixel golf game. Side view: a ball, terrain bumps,
 * a sand trap, and a flag. Tap 1 starts a power meter, tap 2 locks power and
 * starts an angle meter, tap 3 locks the angle and swings. Wind nudges the ball
 * mid-flight; friction stops it; in the hole wins. Multiple procedurally varied
 * holes with a stroke counter.
 */


const FLAG_POLE: PixelSprite = [
  "01",
  "01",
  "01",
  "01",
  "01",
  "01",
  "01",
  "01",
  "01",
  "01",
  "01",
]
const FLAG_CLOTH: PixelSprite = [
  "111111",
  "111111",
  "111111",
]

const GROUND_MARK: PixelSprite = ["111"]

type Phase = "idle" | "power" | "angle" | "flight" | "holed" | "done"

type GameState = {
  width: number
  height: number
  groundY: number
  px: number
  ballX: number
  ballY: number
  vx: number
  vy: number
  holeX: number
  terrainBumps: { x: number; h: number }[]
  sandX: number
  sandW: number
  wind: number // -1..1, sign = direction
  phase: Phase
  power: number // 0..1 oscillating value when in power meter
  powerLocked: number // locked power 0..1
  angle: number // degrees, oscillating during angle phase
  angleLocked: number // degrees
  meterT: number // accumulator for meter oscillation
  strokes: number
  flightTime: number
}

const GRAVITY = 1400
const FRICTION = 0.86
const SAND_FRICTION = 0.5
const HOLE_RADIUS = 6

function makeHole(width: number, groundY: number, px: number, idx: number): Pick<GameState, "holeX" | "terrainBumps" | "sandX" | "sandW" | "ballX" | "ballY" | "wind"> {
  const holeX = width * (0.72 + (idx % 3) * 0.05)
  const bumpCount = 3 + (idx % 4)
  const terrainBumps: { x: number; h: number }[] = []
  for (let i = 0; i < bumpCount; i++) {
    const x = (width * (i + 1)) / (bumpCount + 1) + (Math.random() - 0.5) * px * 4
    terrainBumps.push({ x, h: px * (1 + Math.floor(Math.random() * 3)) })
  }
  const sandX = terrainBumps.length > 1 ? terrainBumps[1].x - px * 6 : width * 0.4
  const sandW = px * (6 + Math.floor(Math.random() * 4))
  const ballX = px * 6
  const ballY = groundY - px * 2
  const wind = Math.round((Math.random() * 2 - 1) * 10) / 10
  return { holeX, terrainBumps, sandX, sandW, ballX, ballY, wind }
}

export default function GolfGame({ className }: { className?: string }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const fgProbeRef = useRef<HTMLSpanElement | null>(null)
  const mutedProbeRef = useRef<HTMLSpanElement | null>(null)
  const accentProbeRef = useRef<HTMLSpanElement | null>(null)
  const stateRef = useRef<GameState | null>(null)
  const rafRef = useRef<number | null>(null)
  const colorsRef = useRef({ fg: "#e5e7eb", muted: "#9ca3af", accent: "#3b82f6" })
  const holeIdxRef = useRef(0)

  const [strokes, setStrokes] = useState(0)
  const [phase, setPhase] = useState<Phase>("idle")
  const [holeNum, setHoleNum] = useState(1)
  const [over, setOver] = useState(false)

  const swing = useCallback(() => {
    const s = stateRef.current
    if (!s) return
    if (s.phase === "flight") return
    if (s.phase === "holed" || s.phase === "done" || s.phase === "idle") {
      // (Re)start / next hole handled by state transitions; idle = first tap.
    }
    if (s.phase === "idle" || s.phase === "holed") {
      // Start power meter.
      s.phase = "power"
      s.power = 0
      s.meterT = 0
      setPhase("power")
      return
    }
    if (s.phase === "power") {
      s.powerLocked = s.power
      s.phase = "angle"
      s.angle = 20
      s.meterT = 0
      setPhase("angle")
      return
    }
    if (s.phase === "angle") {
      s.angleLocked = s.angle
      // Launch.
      const power = 0.25 + s.powerLocked * 0.75
      const speed = power * 900
      const rad = (s.angleLocked * Math.PI) / 180
      s.vx = Math.cos(rad) * speed
      s.vy = -Math.sin(rad) * speed
      s.phase = "flight"
      s.flightTime = 0
      s.strokes += 1
      setStrokes(s.strokes)
      setPhase("flight")
    }
  }, [])

  const nextHole = useCallback(() => {
    const s = stateRef.current
    if (!s) return
    holeIdxRef.current += 1
    setHoleNum(holeIdxRef.current + 1)
    const h = makeHole(s.width, s.groundY, s.px, holeIdxRef.current)
    Object.assign(s, h)
    s.vx = 0
    s.vy = 0
    s.phase = "idle"
    s.strokes = 0
    setStrokes(0)
    setPhase("idle")
  }, [])

  const restart = useCallback(() => {
    const s = stateRef.current
    if (!s) return
    holeIdxRef.current = 0
    setHoleNum(1)
    const h = makeHole(s.width, s.groundY, s.px, 0)
    Object.assign(s, h)
    s.vx = 0
    s.vy = 0
    s.phase = "idle"
    s.strokes = 0
    setOver(false)
    setStrokes(0)
    setPhase("idle")
  }, [])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext("2d")
    if (!ctx) return

    const state: GameState = {
      width: 0,
      height: 0,
      groundY: 0,
      px: 2,
      ballX: 12,
      ballY: 0,
      vx: 0,
      vy: 0,
      holeX: 0,
      terrainBumps: [],
      sandX: 0,
      sandW: 0,
      wind: 0,
      phase: "idle",
      power: 0,
      powerLocked: 0,
      angle: 20,
      angleLocked: 20,
      meterT: 0,
      strokes: 0,
      flightTime: 0,
    }
    stateRef.current = state

    const readColors = () => {
      if (fgProbeRef.current) {
        colorsRef.current.fg = getComputedStyle(fgProbeRef.current).color
      }
      if (mutedProbeRef.current) {
        colorsRef.current.muted = getComputedStyle(mutedProbeRef.current).color
      }
      if (accentProbeRef.current) {
        colorsRef.current.accent = getComputedStyle(accentProbeRef.current).color
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
      state.px = Math.max(2, Math.floor(rect.height / 24))
      state.groundY = rect.height - state.px * 4
      if (state.phase === "idle" && state.ballX < rect.width) {
        const h = makeHole(rect.width, state.groundY, state.px, holeIdxRef.current)
        Object.assign(state, h)
      } else {
        state.ballY = state.groundY - state.px * 2
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

      // ---- Update ----
      if (s.phase === "power") {
        s.meterT += dt
        s.power = (Math.sin(s.meterT * 4) + 1) / 2
      } else if (s.phase === "angle") {
        s.meterT += dt
        s.angle = 20 + ((Math.sin(s.meterT * 3) + 1) / 2) * 55 // 20..75 deg
      } else if (s.phase === "flight") {
        s.flightTime += dt
        s.vy += GRAVITY * dt
        s.vx += s.wind * 30 * dt
        s.ballX += s.vx * dt
        s.ballY += s.vy * dt
        const groundLevel = s.groundY - s.px * 2
        if (s.ballY >= groundLevel) {
          s.ballY = groundLevel
          // Bounce if fast, else roll.
          if (Math.abs(s.vy) > 120) {
            s.vy = -s.vy * 0.45
            s.vx *= 0.7
          } else {
            s.vy = 0
            const inSand = s.ballX >= s.sandX && s.ballX <= s.sandX + s.sandW
            const f = inSand ? SAND_FRICTION : FRICTION
            s.vx *= f ** (dt * 60)
            if (Math.abs(s.vx) < 8) {
              s.vx = 0
              s.phase = "idle"
              setPhase("idle")
            }
          }
        }
        // In the hole?
        if (Math.abs(s.ballX - s.holeX) < HOLE_RADIUS && s.ballY >= s.groundY - s.px * 3) {
          s.phase = "holed"
          setPhase("holed")
        }
        // Out of bounds.
        if (s.ballX < -20 || s.ballX > s.width + 20) {
          s.vx = 0
          s.vy = 0
          s.phase = "idle"
          s.ballX = s.px * 6
          s.ballY = s.groundY - s.px * 2
          setPhase("idle")
        }
      }

      // ---- Render ----
      ctx.clearRect(0, 0, s.width, s.height)

      // Sky already transparent (bg-muted). Draw wind arrow at top.
      if (s.phase === "flight" || s.phase === "power" || s.phase === "angle") {
        ctx.fillStyle = muted
        const wy = s.px * 2
        const arrow = s.wind * 14
        ctx.fillRect(s.width / 2, wy, arrow, Math.max(1, s.px / 2))
        ctx.fillText("", 0, 0)
      }

      // Ground line.
      ctx.fillStyle = muted
      const lineH = Math.max(1, Math.floor(s.px / 2))
      ctx.fillRect(0, s.groundY, s.width, lineH)
      ctx.globalAlpha = 0.5
      for (let x = 0; x < s.width; x += s.px * 5) {
        ctx.fillRect(x, s.groundY + s.px * 1.5, s.px * 2, lineH)
      }
      ctx.globalAlpha = 1

      // Terrain bumps.
      ctx.fillStyle = fg
      ctx.globalAlpha = 0.8
      for (const b of s.terrainBumps) {
        drawSprite(ctx, GROUND_MARK, b.x - s.px * 1.5, s.groundY - b.h, s.px)
      }
      ctx.globalAlpha = 1

      // Sand trap.
      ctx.globalAlpha = 0.35
      ctx.fillStyle = fg
      for (let x = s.sandX; x < s.sandX + s.sandW; x += s.px) {
        ctx.fillRect(x, s.groundY - 1, s.px, s.px * 2)
      }
      ctx.globalAlpha = 1

      // Hole + flag.
      ctx.fillStyle = fg
      const holeY = s.groundY - s.px * 2
      ctx.globalAlpha = 0.9
      ctx.fillRect(s.holeX - HOLE_RADIUS / 2, holeY, HOLE_RADIUS, s.px * 2)
      ctx.globalAlpha = 1
      drawSprite(ctx, FLAG_POLE, s.holeX + HOLE_RADIUS / 2, s.groundY - FLAG_POLE.length * s.px, s.px)
      ctx.fillStyle = accent
      drawSprite(ctx, FLAG_CLOTH, s.holeX + HOLE_RADIUS / 2 + s.px, s.groundY - FLAG_POLE.length * s.px, s.px)
      ctx.fillStyle = fg

      // Ball.
      ctx.fillStyle = fg

      ctx.fillRect(s.ballX - s.px / 2, s.ballY, s.px, s.px)


      // Power meter (left edge bar).
      if (s.phase === "power" || s.phase === "angle") {
        const meterX = s.px * 2
        const meterW = s.px * 2
        const meterH = s.height - s.px * 8
        ctx.fillStyle = muted
        ctx.globalAlpha = 0.3
        ctx.fillRect(meterX, s.px * 3, meterW, meterH)
        ctx.globalAlpha = 1
        ctx.fillStyle = accent
        if (s.phase === "power") {
          ctx.fillRect(meterX, s.px * 3 + meterH * (1 - s.power), meterW, meterH * s.power)
        } else {
          // Angle: fill from bottom proportional to angle (20..75).
          const frac = (s.angle - 20) / 55
          ctx.fillRect(meterX, s.px * 3 + meterH * (1 - frac), meterW, meterH * frac)
        }
      }

      // Aim preview line during angle phase.
      if (s.phase === "angle") {
        ctx.strokeStyle = muted
        ctx.globalAlpha = 0.5
        ctx.lineWidth = Math.max(1, s.px / 2)
        const rad = (s.angle * Math.PI) / 180
        const len = 40 + s.powerLocked * 30
        ctx.beginPath()
        ctx.moveTo(s.ballX, s.ballY)
        ctx.lineTo(s.ballX + Math.cos(rad) * len, s.ballY - Math.sin(rad) * len)
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

  // Keyboard: Space/Enter triggers swing, but never steals typing.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null
      const typing =
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable)
      if (typing) return
      if (e.code === "Space" || e.code === "Enter" || e.key === " ") {
        e.preventDefault()
        const s = stateRef.current
        if (!s) return
        if (s.phase === "holed") nextHole()
        else if (s.phase === "done" || over) restart()
        else swing()
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [swing, nextHole, restart, over])

  const handleTap = useCallback(() => {
    const s = stateRef.current
    if (!s) return
    if (s.phase === "holed") nextHole()
    else if (s.phase === "done" || over) restart()
    else swing()
  }, [swing, nextHole, restart, over])

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
        onClick={handleTap}
        onTouchStart={(e) => {
          e.preventDefault()
          handleTap()
        }}
        className="block h-full w-full cursor-pointer touch-none"
      />

      <div className="pointer-events-none absolute left-2 top-1.5 text-[11px] tabular-nums font-medium text-muted-foreground">
        Hole {holeNum} · {strokes} strokes
      </div>

      {(phase === "idle" || phase === "holed" || over) && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <span className="rounded-full bg-background/70 px-3 py-1 text-[11px] font-medium text-muted-foreground backdrop-blur-sm">
            {over
              ? "Round done — tap to replay"
              : phase === "holed"
                ? "In the hole! Tap for next"
                : "Tap to start your swing"}
          </span>
        </div>
      )}
    </div>
  )
}
