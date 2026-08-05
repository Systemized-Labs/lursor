import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { ThemePicker } from "@/components/ui/theme-picker"
import { useAppearance } from "@/hooks/use-appearance"
import {
  DEFAULT_FONT_SIZE,
  FONT_CATEGORIES,
  FONT_FAMILIES,
  FONT_SIZES,
} from "@/lib/appearance"
import { ThemeScheduleSection } from "@/pages/settings/theme-schedule-section"

/**
 * Appearance controls — theme, font family and font size. Font changes apply
 * instantly (and persist) via {@link useAppearance}; the theme is owned by
 * next-themes through the shared {@link ThemePicker}. Time-of-day theme cycling
 * lives in its own card below (see {@link ThemeScheduleSection}).
 */
export function AppearanceSection() {
  const { fontFamily, setFontFamily, fontSize, setFontSize } = useAppearance()

  return (
    <div className="grid gap-6">
      <Card>
        <CardHeader>
          <CardTitle>Theme and typography</CardTitle>
          <CardDescription>
            Choose your theme and how text is rendered across the app.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-6 sm:max-w-md">
          <div className="grid gap-2">
            <Label>Theme</Label>
            <ThemePicker />
          </div>

          <div className="grid gap-2">
            <Label htmlFor="font-family">Font family</Label>
            <Select value={fontFamily} onValueChange={setFontFamily}>
              <SelectTrigger id="font-family">
                <SelectValue placeholder="Select a font" />
              </SelectTrigger>
              <SelectContent>
                {FONT_CATEGORIES.map((category) => (
                  <SelectGroup key={category}>
                    <SelectLabel>{category}</SelectLabel>
                    {FONT_FAMILIES.filter((f) => f.category === category).map((f) => (
                      <SelectItem key={f.value} value={f.value}>
                        <span style={{ fontFamily: f.stack }}>{f.label}</span>
                      </SelectItem>
                    ))}
                  </SelectGroup>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="grid gap-2">
            <Label htmlFor="font-size">Font size</Label>
            <Select
              value={String(fontSize)}
              onValueChange={(v) => setFontSize(Number(v))}
            >
              <SelectTrigger id="font-size">
                <SelectValue placeholder="Select a size" />
              </SelectTrigger>
              <SelectContent>
                {FONT_SIZES.map((px) => (
                  <SelectItem key={px} value={String(px)}>
                    {px}px{px === DEFAULT_FONT_SIZE ? " (Default)" : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              Scales all text and spacing across the app.
            </p>
          </div>
        </CardContent>
      </Card>

      <ThemeScheduleSection />
    </div>
  )
}
