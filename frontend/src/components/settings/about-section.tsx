import { Link } from "react-router-dom"

import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"

/**
 * What you're running, and the way back into the first-run walkthrough.
 *
 * Both used to live at the bottom of the Settings page's General tab — the
 * version because "what am I actually running" matters most when reporting a bug,
 * the walkthrough because `/welcome` is otherwise a URL only a fresh install can
 * find. Neither belongs in a category about agents or providers, so they get one
 * of their own.
 *
 * The reference UI puts export / import / reset here too. Omitted: there is no
 * backend for any of the three, and three buttons that need new endpoints are
 * worse than not shipping them.
 */
export function AboutSection() {
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Lursor</CardTitle>
          <CardDescription>
            Self-hosted agent harness with workspaces, live terminal, and git
            review.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {/* Selectable, so it can be pasted straight into an issue. */}
          <p className="select-text text-sm text-muted-foreground tabular-nums">
            Version {__APP_VERSION__}
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Setup walkthrough</CardTitle>
          <CardDescription>
            Step back through models, GitHub, and your first workspace. It derives
            each step from what exists, so this is a read of what is set up as
            much as a re-run.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button asChild variant="outline" size="sm">
            <Link to="/welcome">Open walkthrough</Link>
          </Button>
        </CardContent>
      </Card>
    </div>
  )
}
