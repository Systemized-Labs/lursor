import {
  Airplane,
  Anchor,
  Atom,
  Bank,
  Bell,
  Bicycle,
  Bird,
  Boat,
  Book,
  Briefcase,
  Bug,
  Buildings,
  Butterfly,
  Cactus,
  Camera,
  Car,
  Cat,
  ChartLine,
  ChatCircle,
  Coffee,
  Coins,
  Compass,
  CookingPot,
  Cpu,
  CreditCard,
  Crown,
  Cube,
  Database,
  Desktop,
  DeviceMobile,
  Diamond,
  Dog,
  Envelope,
  Factory,
  Feather,
  FileText,
  FilmSlate,
  Fish,
  Flame,
  Flask,
  GameController,
  Gear,
  Ghost,
  Globe,
  GraduationCap,
  Guitar,
  Hammer,
  Heart,
  House,
  Key,
  Leaf,
  Lightbulb,
  Lightning,
  MapTrifold,
  Moon,
  Mountains,
  MusicNotes,
  Newspaper,
  Note,
  Package,
  Palette,
  PawPrint,
  Pencil,
  Planet,
  Plant,
  PuzzlePiece,
  Robot,
  Rocket,
  Shield,
  ShoppingCart,
  Snowflake,
  Sparkle,
  Star,
  Stethoscope,
  Storefront,
  Sun,
  Target,
  Terminal,
  TestTube,
  Toolbox,
  Tree,
  Trophy,
  Truck,
  Users,
  Wrench,
  type Icon,
} from "@phosphor-icons/react"

/**
 * Per-workspace icons for the rail.
 *
 * The rail is 68px wide and the shell's display font is wide — about five
 * characters at 10px — so every text scheme tried here collapsed on real repo
 * names: a two-letter monogram turned `cat-adoption`, `cat-landing` and
 * `cat-lovers` into three identical `CL`s, and splitting the name over two lines
 * turned them into three identical `cat-`/`land…`s. Eleven characters of identity
 * will not fit in five, so identity lives in a glyph instead.
 *
 * Phosphor rather than emoji, which this briefly used. Emoji were free colour in a
 * codebase with 89 themes, but they are somebody else's artwork rendered by the
 * OS: inconsistent in weight against a UI drawn entirely in Phosphor, unstyleable
 * (they ignore `currentColor`, so "inactive" could only be faked with opacity),
 * and unpredictable in silhouette — several rendered as dark photographic
 * rectangles at rail size. Line icons take `currentColor`, so state can be
 * expressed properly, and Phosphor ships weights: the same glyph outlined when
 * idle and filled when active, which is a far stronger active state than a tint.
 */

/** A name for the picker's tooltip, and the component that draws it. */
export interface WorkspaceIconDef {
  key: string
  label: string
  Icon: Icon
}

/**
 * Every icon a workspace can wear, in picker order — grouped so the grid reads as
 * places/things/animals/work rather than as a bag of glyphs.
 */
export const WORKSPACE_ICONS: WorkspaceIconDef[] = [
  { key: "house", label: "House", Icon: House },
  { key: "globe", label: "Globe", Icon: Globe },
  { key: "rocket", label: "Rocket", Icon: Rocket },
  { key: "cube", label: "Cube", Icon: Cube },
  { key: "package", label: "Package", Icon: Package },
  { key: "buildings", label: "Buildings", Icon: Buildings },
  { key: "factory", label: "Factory", Icon: Factory },
  { key: "storefront", label: "Storefront", Icon: Storefront },

  { key: "device-mobile", label: "Mobile", Icon: DeviceMobile },
  { key: "desktop", label: "Desktop", Icon: Desktop },
  { key: "terminal", label: "Terminal", Icon: Terminal },
  { key: "cpu", label: "Chip", Icon: Cpu },
  { key: "database", label: "Database", Icon: Database },
  { key: "gear", label: "Gear", Icon: Gear },
  { key: "robot", label: "Robot", Icon: Robot },
  { key: "bug", label: "Bug", Icon: Bug },

  { key: "cat", label: "Cat", Icon: Cat },
  { key: "dog", label: "Dog", Icon: Dog },
  { key: "paw-print", label: "Paw", Icon: PawPrint },
  { key: "bird", label: "Bird", Icon: Bird },
  { key: "fish", label: "Fish", Icon: Fish },
  { key: "butterfly", label: "Butterfly", Icon: Butterfly },
  { key: "leaf", label: "Leaf", Icon: Leaf },
  { key: "plant", label: "Plant", Icon: Plant },

  { key: "tree", label: "Tree", Icon: Tree },
  { key: "cactus", label: "Cactus", Icon: Cactus },
  { key: "mountains", label: "Mountains", Icon: Mountains },
  { key: "sun", label: "Sun", Icon: Sun },
  { key: "moon", label: "Moon", Icon: Moon },
  { key: "star", label: "Star", Icon: Star },
  { key: "planet", label: "Planet", Icon: Planet },
  { key: "snowflake", label: "Snowflake", Icon: Snowflake },

  { key: "puzzle-piece", label: "Puzzle", Icon: PuzzlePiece },
  { key: "game-controller", label: "Game", Icon: GameController },
  { key: "target", label: "Target", Icon: Target },
  { key: "trophy", label: "Trophy", Icon: Trophy },
  { key: "guitar", label: "Guitar", Icon: Guitar },
  { key: "music-notes", label: "Music", Icon: MusicNotes },
  { key: "film-slate", label: "Film", Icon: FilmSlate },
  { key: "camera", label: "Camera", Icon: Camera },
  { key: "palette", label: "Palette", Icon: Palette },

  { key: "sparkle", label: "Sparkle", Icon: Sparkle },
  { key: "lightbulb", label: "Idea", Icon: Lightbulb },
  { key: "lightning", label: "Lightning", Icon: Lightning },
  { key: "flame", label: "Flame", Icon: Flame },
  { key: "diamond", label: "Diamond", Icon: Diamond },
  { key: "crown", label: "Crown", Icon: Crown },
  { key: "heart", label: "Heart", Icon: Heart },
  { key: "ghost", label: "Ghost", Icon: Ghost },

  { key: "file-text", label: "Document", Icon: FileText },
  { key: "note", label: "Note", Icon: Note },
  { key: "book", label: "Book", Icon: Book },
  { key: "pencil", label: "Pencil", Icon: Pencil },
  { key: "chat-circle", label: "Chat", Icon: ChatCircle },
  { key: "envelope", label: "Mail", Icon: Envelope },
  { key: "newspaper", label: "News", Icon: Newspaper },
  { key: "bell", label: "Bell", Icon: Bell },

  { key: "flask", label: "Flask", Icon: Flask },
  { key: "test-tube", label: "Test tube", Icon: TestTube },
  { key: "atom", label: "Atom", Icon: Atom },
  { key: "wrench", label: "Wrench", Icon: Wrench },
  { key: "hammer", label: "Hammer", Icon: Hammer },
  { key: "toolbox", label: "Toolbox", Icon: Toolbox },
  { key: "shield", label: "Shield", Icon: Shield },
  { key: "key", label: "Key", Icon: Key },

  { key: "chart-line", label: "Chart", Icon: ChartLine },
  { key: "briefcase", label: "Briefcase", Icon: Briefcase },
  { key: "shopping-cart", label: "Cart", Icon: ShoppingCart },
  { key: "credit-card", label: "Card", Icon: CreditCard },
  { key: "coins", label: "Coins", Icon: Coins },
  { key: "bank", label: "Bank", Icon: Bank },
  { key: "users", label: "People", Icon: Users },
  { key: "graduation-cap", label: "School", Icon: GraduationCap },

  { key: "map-trifold", label: "Map", Icon: MapTrifold },
  { key: "compass", label: "Compass", Icon: Compass },
  { key: "anchor", label: "Anchor", Icon: Anchor },
  { key: "boat", label: "Boat", Icon: Boat },
  { key: "airplane", label: "Plane", Icon: Airplane },
  { key: "car", label: "Car", Icon: Car },
  { key: "bicycle", label: "Bicycle", Icon: Bicycle },
  { key: "truck", label: "Truck", Icon: Truck },

  { key: "cooking-pot", label: "Cooking", Icon: CookingPot },
  { key: "coffee", label: "Coffee", Icon: Coffee },
  { key: "stethoscope", label: "Health", Icon: Stethoscope },
  { key: "feather", label: "Feather", Icon: Feather },
]

const BY_KEY = new Map(WORKSPACE_ICONS.map((def) => [def.key, def]))

/** Fallback when a stored key refers to an icon that no longer exists. */
const FALLBACK: WorkspaceIconDef = { key: "cube", label: "Cube", Icon: Cube }

/**
 * Keyword → icon key, checked in order.
 *
 * Ordered **subject before kind**, which is the whole trick. A first pass had
 * `landing` near the top for specificity, and `dog-landing`, `cat-landing` and
 * `lursor-landing` all came out as the same globe — reproducing, with a different
 * glyph, exactly the collision that killed the monograms. In `dog-landing` the dog
 * is the identity and the landing page is the format, and far more projects *are*
 * a web page than are about dogs. So living things and domain subjects match
 * first, and the generic web/page/site words sit at the bottom as a last resort.
 *
 * Boundaries (`\b`) on every keyword that is a common substring, because without
 * them `shop` matched "Workshop", `star` matched "startup", `doc` matched
 * "docker", `ai` matched "explain" and `cat` matched "catalog".
 */
const KEYWORD_ICONS: [RegExp, string][] = [
  // Compounds first, where a part would otherwise win over the whole.
  [/minecraft|voxel|\bblocks?\b/, "cube"],
  [/workshop/, "toolbox"],
  [/puzzle/, "puzzle-piece"],

  // Living things — the most distinguishing thing a name can carry.
  [/\bcats?\b|kitten|feline/, "cat"],
  [/\bdogs?\b|puppy|\bpups?\b|canine/, "dog"],
  [/\bpets?\b|animal|adopt/, "paw-print"],
  [/\bbirds?\b|parrot/, "bird"],
  [/\bfish\b|shark/, "fish"],
  [/butterfly|\bbugs?\b|insect/, "butterfly"],
  [/plant|garden|\bgrow\b|\bseed\b|bloom/, "plant"],
  [/\bfarm\b|\bfield\b|harvest|\bleaf\b/, "leaf"],
  [/\btrees?\b|forest|\bwood\b/, "tree"],

  // Domain subjects.
  [/\bgames?\b|arcade|\bplay\b/, "game-controller"],
  [/galaxy|space|cosmos|nebula|astro|planet|orbit/, "planet"],
  [/\bstars?\b|stella/, "star"],
  [/\bmoon\b|luna|\bnight\b/, "moon"],
  [/\bsun\b|solar|\bday\b/, "sun"],
  [/mountain|\bpeak\b|\bhike\b|summit/, "mountains"],
  [/\bsnow\b|winter|\bice\b|frost/, "snowflake"],
  [/music|audio|\bsongs?\b|guitar/, "guitar"],
  [/\bsound\b|podcast|\bradio\b/, "music-notes"],
  [/video|\bfilms?\b|movie|stream|cinema/, "film-slate"],
  [/photo|image|gallery|camera/, "camera"],
  [/food|recipe|cook|kitchen/, "cooking-pot"],
  [/coffee|\bcafe\b|\btea\b|\bbrew\b/, "coffee"],
  [/health|\bfit\b|\bmed\b|medical|clinic/, "stethoscope"],
  [/school|learn|course|\bedu\b|tutor|academy/, "graduation-cap"],
  [/\bnews\b|\bblog\b|article|press/, "newspaper"],
  [/\bmaps?\b|\bgeo\b|location|atlas/, "map-trifold"],
  [/travel|\btrip\b|\btour\b|voyage/, "compass"],
  [/\bboat\b|\bship\b|sail|marine|harbou?r/, "boat"],
  [/\bflight\b|\bplane\b|airline|airport/, "airplane"],
  [/\bcars?\b|\bauto\b|vehicle|drive/, "car"],
  [/\bbikes?\b|bicycle|cycling/, "bicycle"],
  [/trophy|\bwins?\b|champion|league|contest/, "trophy"],
  [/\bteams?\b|\busers?\b|people|social|community|member/, "users"],

  // Commerce and money.
  [/\bshops?\b|\bstores?\b|\bsale\b|\bcart\b|commerce|checkout|market/, "shopping-cart"],
  [/\bpay\b|payment|billing|invoice|\bbank\b/, "credit-card"],
  [/money|finance|revenue|\bcoins?\b|crypto|token/, "coins"],

  // Platforms.
  [/mobile|\bphone\b|\bios\b|android|\bapps?\b/, "device-mobile"],
  [/desktop|electron|\bmac\b|windows/, "desktop"],
  [/\bcli\b|terminal|shell|console|\bbash\b/, "terminal"],

  // Craft and content.
  [/skill|magic|spell|wizard/, "sparkle"],
  [/studio|design|brand|paint|\bart\b|theme/, "palette"],
  [/\bdocs?\b|readme|wiki|guide|manual/, "file-text"],
  [/\bbooks?\b|library|novel|story/, "book"],
  [/\bnotes?\b|memo|journal|draft/, "note"],
  [/\bchat\b|\btalk\b|message|comment|forum/, "chat-circle"],
  [/\bmail\b|email|inbox|newsletter|smtp/, "envelope"],
  [/\bidea\b|\bthink\b|brainstorm|concept/, "lightbulb"],

  // Technical function.
  [/\bapi\b|server|backend|microservice|gateway/, "gear"],
  [/\bdb\b|database|\bsql\b|\bdata\b|warehouse/, "database"],
  [/auth|login|secure|crypto|\bkeys?\b|\bsso\b/, "key"],
  [/\bsecurity\b|firewall|\bguard\b|protect/, "shield"],
  [/\btests?\b|\bspec\b|\bqa\b|\blab\b|experiment/, "flask"],
  [/\bbots?\b|agent|\bai\b|\bllm\b|model|neural/, "robot"],
  [/\bbugs?\b|\bfix\b|issue|debug|patch/, "bug"],
  [/deploy|\bship\b|release|\bbuild\b|\bci\b|pipeline/, "truck"],
  [/monitor|metric|analytic|chart|\bdash\b|report/, "chart-line"],
  [/\bchip\b|hardware|firmware|embedded|kernel|\bgpu\b/, "cpu"],
  [/physics|science|\batom\b|quantum|research/, "atom"],
  [/\btools?\b|\butil\b|\bkit\b|helper|script/, "wrench"],
  [/\bcore\b|engine|platform|framework|infra/, "cube"],
  [/\bmine\b|\bdig\b|quarry|\bforge\b|craft/, "hammer"],
  [/\bwork\b|\bjobs?\b|career|hire|\bcrm\b|client/, "briefcase"],
  [/\bfast\b|\bspeed\b|\bperf\b|turbo|instant/, "lightning"],
  [/\bfire\b|\bhot\b|burn|blaze/, "flame"],
  [/premium|\bpro\b|\bvip\b|elite/, "crown"],
  [/\blove\b|\bfav\b|favourite|favorite|\bwish\b/, "heart"],
  [/ghost|spooky|halloween|phantom/, "ghost"],
  [/\bgems?\b|\bjewel\b|diamond|treasure/, "diamond"],
  [/\balert\b|notify|notification|remind/, "bell"],
  [/\bboxes?\b|\bpack\b|bundle|inventory|\bstock\b/, "package"],
  [/\bhomes?\b|\bhouse\b|\breal\b.?estate|property/, "house"],
  [/\bcity\b|urban|office|\bcorp\b/, "buildings"],
  [/\bfactory\b|manufactur|industrial|plant\b/, "factory"],
  [/rocket|launch|\bstartups?\b|\bboost\b/, "rocket"],
  [/\btarget\b|\bgoals?\b|\bfocus\b|\baim\b/, "target"],

  // Last: the format, not the subject. Only reached when nothing above said what
  // the project is *about*.
  [/landing|website|\bweb\b|\bsite\b|\bpages?\b|\bwww\b|\bhttp\b/, "globe"],
]

/**
 * Fallback pool for names that match nothing — spread across the grid so two
 * unmatched workspaces are unlikely to collide, and chosen for distinguishable
 * silhouettes at 22px rather than for meaning they can't carry anyway.
 */
const FALLBACK_KEYS = [
  "cube", "diamond", "compass", "anchor", "feather", "cactus", "snowflake",
  "atom", "shield", "star", "moon", "heart", "flame", "lightning", "ghost",
  "target", "bell", "leaf", "coffee", "trophy", "package", "key", "note",
  "pencil",
]

/** Stable small hash of a string — same workspace, same fallback, every load. */
function hash(value: string): number {
  let h = 2166136261
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return Math.abs(h)
}

/**
 * The icon key a workspace gets before anyone picks one for it.
 *
 * Keyword-matched where possible, because a guessed-right icon is worth far more
 * than a random one: `cat-landing` arriving as a cat is immediately the cat
 * project, with nothing to configure. Falls back to a stable pick keyed on the id
 * rather than the name, so renaming a workspace doesn't silently change its face.
 */
export function defaultIconKey(name: string, id: string): string {
  const haystack = name.toLowerCase()
  for (const [pattern, key] of KEYWORD_ICONS) {
    if (pattern.test(haystack)) return key
  }
  return FALLBACK_KEYS[hash(id) % FALLBACK_KEYS.length]
}

/** Resolve a key to its definition, tolerating keys from an older build. */
export function iconDef(key: string): WorkspaceIconDef {
  return BY_KEY.get(key) ?? FALLBACK
}

const STORAGE_KEY = "lursor:workspace-icons"

/** Explicit per-workspace choices, keyed by workspace id. */
export type IconOverrides = Record<string, string>

export function readIconOverrides(): IconOverrides {
  if (typeof window === "undefined") return {}
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : {}
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {}
    const out: IconOverrides = {}
    for (const [id, key] of Object.entries(parsed as Record<string, unknown>)) {
      // Drop anything that isn't a key we still ship — this store held emoji
      // before icons, and a stray "🐱" would otherwise resolve to the fallback
      // forever rather than to the workspace's keyword match.
      if (typeof key === "string" && BY_KEY.has(key)) out[id] = key
    }
    return out
  } catch {
    return {}
  }
}

export function writeIconOverrides(overrides: IconOverrides): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(overrides))
  } catch {
    // Ignore quota / disabled-storage errors — icon choices are best-effort.
  }
}
