import { useEffect, useState } from "react";
import { dict, fmt, type Dict, type Lang } from "./i18n";

/* ------------------------------------------------------------------ */
/* Game configuration                                                  */
/* Rules from the brief are fixed. Values marked TUNE were not in the  */
/* brief; adjust them to match your original v0 numbers.               */
/* ------------------------------------------------------------------ */

type ResourceKey = "stone" | "steel" | "gold";
type UnitKey = "foot" | "archers" | "cavalry";
type BuildingKey = "market" | "garden";
type Bag = Record<ResourceKey, number>;
type Army = Record<UnitKey, number>;

const MAX_TURNS = 24;
const MAX_LEVEL = 5;
const RAID_EVERY = 4;
const WIN_UNITS = 12;
const WALL_PER_LEVEL = 4;
const LOSS_DIVISOR = 4; // TUNE: each 4 points of deficit costs one unit

const RESOURCES: ResourceKey[] = ["stone", "steel", "gold"];
const UNITS: UnitKey[] = ["foot", "archers", "cavalry"];
const BUILDING_KEYS: BuildingKey[] = ["market", "garden"];

const START_RESOURCES: Bag = { stone: 20, steel: 10, gold: 15 }; // TUNE
const BASE_INCOME: Bag = { stone: 3, steel: 2, gold: 3 }; // TUNE

const BUILDINGS: Record<BuildingKey, { cost: Bag; income: Bag }> = {
  market: {
    cost: { stone: 8, steel: 0, gold: 4 }, // TUNE
    income: { stone: 0, steel: 0, gold: 5 }, // TUNE
  },
  garden: {
    cost: { stone: 6, steel: 0, gold: 2 }, // TUNE
    income: { stone: 2, steel: 2, gold: 0 }, // TUNE
  },
};

// Costs read as stone / steel / gold; strength is the per-unit bonus.
const UNIT_DATA: Record<UnitKey, { cost: Bag; strength: number }> = {
  foot: { cost: { stone: 5, steel: 2, gold: 8 }, strength: 2 },
  archers: { cost: { stone: 8, steel: 5, gold: 13 }, strength: 4 },
  cavalry: { cost: { stone: 12, steel: 9, gold: 22 }, strength: 8 },
};

const upgradeCost = (level: number): Bag => ({
  stone: 12 * level, // TUNE
  steel: 6 * level,
  gold: 10 * level,
});

const raidThreat = (raidNumber: number) => 6 + 6 * raidNumber; // TUNE

/* ------------------------------------------------------------------ */
/* Data model: events and reports hold data, never translated text      */
/* ------------------------------------------------------------------ */

type EventBody =
  | { kind: "start" }
  | { kind: "build"; building: BuildingKey }
  | { kind: "upgrade"; level: number }
  | { kind: "recruit"; unit: UnitKey }
  | { kind: "rest" }
  | {
      kind: "raid";
      won: boolean;
      threat: number;
      defense: number;
      lost: number;
      reward: number;
    }
  | { kind: "victory"; level: number; units: number }
  | { kind: "defeat" };

interface GameEvent {
  id: number;
  turn: number;
  body: EventBody;
}

type StageKey = "archers" | "foot" | "cavalry" | "walls";

interface BattleStage {
  key: StageKey;
  count: number;
  mult: number;
  strength: number;
}

interface BattleReport {
  turn: number;
  raidNumber: number;
  threat: number;
  stages: BattleStage[];
  defense: number;
  won: boolean;
  casualties: Army;
  lost: number;
  reward: number;
  remaining: number;
}

type Status = "playing" | "victory" | "defeat";

interface Game {
  turn: number;
  level: number;
  res: Bag;
  plots: (BuildingKey | null)[];
  army: Army;
  log: GameEvent[];
  nextId: number;
  report: BattleReport | null;
  status: Status;
}

type Action =
  | { type: "build"; plot: number; building: BuildingKey }
  | { type: "upgrade" }
  | { type: "recruit"; unit: UnitKey }
  | { type: "rest" };

/* ------------------------------------------------------------------ */
/* Pure game logic                                                     */
/* ------------------------------------------------------------------ */

const sumUnits = (a: Army) => a.foot + a.archers + a.cavalry;
const canAfford = (res: Bag, cost: Bag) =>
  RESOURCES.every((r) => res[r] >= cost[r]);
const pay = (res: Bag, cost: Bag): Bag => ({
  stone: res.stone - cost.stone,
  steel: res.steel - cost.steel,
  gold: res.gold - cost.gold,
});
const gain = (res: Bag, add: Bag): Bag => ({
  stone: res.stone + add.stone,
  steel: res.steel + add.steel,
  gold: res.gold + add.gold,
});

function totalIncome(plots: (BuildingKey | null)[]): Bag {
  return plots.reduce<Bag>(
    (acc, p) => (p ? gain(acc, BUILDINGS[p].income) : acc),
    { ...BASE_INCOME },
  );
}

function newGame(): Game {
  return {
    turn: 1,
    level: 1,
    res: { ...START_RESOURCES },
    plots: [null],
    army: { foot: 0, archers: 0, cavalry: 0 },
    log: [{ id: 0, turn: 1, body: { kind: "start" } }],
    nextId: 1,
    report: null,
    status: "playing",
  };
}

function resolveRaid(
  army: Army,
  level: number,
  turn: number,
): { report: BattleReport; army: Army } {
  const raidNumber = turn / RAID_EVERY;
  const threat = raidThreat(raidNumber);

  // Stages use the army as it stood before casualties.
  const stages: BattleStage[] = [
    {
      key: "archers",
      count: army.archers,
      mult: UNIT_DATA.archers.strength,
      strength: army.archers * UNIT_DATA.archers.strength,
    },
    {
      key: "foot",
      count: army.foot,
      mult: UNIT_DATA.foot.strength,
      strength: army.foot * UNIT_DATA.foot.strength,
    },
    {
      key: "cavalry",
      count: army.cavalry,
      mult: UNIT_DATA.cavalry.strength,
      strength: army.cavalry * UNIT_DATA.cavalry.strength,
    },
    {
      key: "walls",
      count: level,
      mult: WALL_PER_LEVEL,
      strength: level * WALL_PER_LEVEL,
    },
  ];
  const defense = stages.reduce((s, st) => s + st.strength, 0);
  const won = defense >= threat;

  const casualties: Army = { foot: 0, archers: 0, cavalry: 0 };
  const remainingArmy: Army = { ...army };
  let reward = 0;

  if (won) {
    reward = Math.ceil(threat / 2);
  } else {
    let toLose = Math.min(
      sumUnits(army),
      Math.ceil((threat - defense) / LOSS_DIVISOR),
    );
    // Casualties fall on foot soldiers first, then archers, then cavalry.
    for (const unit of ["foot", "archers", "cavalry"] as UnitKey[]) {
      const take = Math.min(toLose, remainingArmy[unit]);
      remainingArmy[unit] -= take;
      casualties[unit] = take;
      toLose -= take;
    }
  }

  return {
    army: remainingArmy,
    report: {
      turn,
      raidNumber,
      threat,
      stages,
      defense,
      won,
      casualties,
      lost: sumUnits(casualties),
      reward,
      remaining: sumUnits(remainingArmy),
    },
  };
}

function applyAction(g: Game, a: Action): Game {
  if (g.status !== "playing") return g;

  let res = { ...g.res };
  let level = g.level;
  const plots = [...g.plots];
  let army = { ...g.army };
  const log = [...g.log];
  let nextId = g.nextId;
  let report = g.report;
  const push = (body: EventBody) =>
    log.push({ id: nextId++, turn: g.turn, body });

  if (a.type === "build") {
    const cost = BUILDINGS[a.building].cost;
    if (plots[a.plot] !== null || !canAfford(res, cost)) return g;
    res = pay(res, cost);
    plots[a.plot] = a.building;
    push({ kind: "build", building: a.building });
  } else if (a.type === "upgrade") {
    if (level >= MAX_LEVEL) return g;
    const cost = upgradeCost(level);
    if (!canAfford(res, cost)) return g;
    res = pay(res, cost);
    level += 1;
    plots.push(null); // one new plot per castle level
    push({ kind: "upgrade", level });
  } else if (a.type === "recruit") {
    const cost = UNIT_DATA[a.unit].cost;
    if (!canAfford(res, cost)) return g;
    res = pay(res, cost);
    army = { ...army, [a.unit]: army[a.unit] + 1 };
    push({ kind: "recruit", unit: a.unit });
  } else {
    push({ kind: "rest" });
  }

  // End of turn: income, then the raid on every fourth turn.
  res = gain(res, totalIncome(plots));

  if (g.turn % RAID_EVERY === 0) {
    const out = resolveRaid(army, level, g.turn);
    army = out.army;
    res = { ...res, gold: res.gold + out.report.reward };
    report = out.report;
    push({
      kind: "raid",
      won: out.report.won,
      threat: out.report.threat,
      defense: out.report.defense,
      lost: out.report.lost,
      reward: out.report.reward,
    });
  }

  let status: Status = "playing";
  let turn = g.turn;
  const units = sumUnits(army);
  if (level === MAX_LEVEL && units >= WIN_UNITS) {
    status = "victory";
    push({ kind: "victory", level, units });
  } else if (g.turn >= MAX_TURNS) {
    status = "defeat";
    push({ kind: "defeat" });
  } else {
    turn = g.turn + 1;
  }

  return { turn, level, res, plots, army, log, nextId, report, status };
}

/* ------------------------------------------------------------------ */
/* Presentation helpers                                                */
/* ------------------------------------------------------------------ */

function bagText(bag: Bag, t: Dict, signed: boolean): string {
  return RESOURCES.filter((r) => bag[r] > 0)
    .map((r) =>
      signed ? `+${bag[r]} ${t[r]}` : `${t[r]} ${bag[r]}`,
    )
    .join(t.listSep);
}

function eventText(e: GameEvent, t: Dict): string {
  const b = e.body;
  switch (b.kind) {
    case "start":
      return t.evStart;
    case "build":
      return fmt(t.evBuild, { turn: e.turn, building: t[b.building] });
    case "upgrade":
      return fmt(t.evUpgrade, { turn: e.turn, level: b.level });
    case "recruit":
      return fmt(t.evRecruit, { turn: e.turn, unit: t[b.unit] });
    case "rest":
      return fmt(t.evRest, { turn: e.turn });
    case "raid":
      return b.won
        ? fmt(t.evRaidWon, {
            turn: e.turn,
            threat: b.threat,
            defense: b.defense,
            reward: b.reward,
            gold: t.gold,
          })
        : fmt(t.evRaidLost, {
            turn: e.turn,
            threat: b.threat,
            defense: b.defense,
            lost: b.lost,
          });
    case "victory":
      return fmt(t.evVictory, {
        turn: e.turn,
        level: b.level,
        units: b.units,
      });
    case "defeat":
      return fmt(t.evDefeat, { turn: e.turn });
  }
}

const STAGE_LABEL: Record<StageKey, keyof Dict> = {
  archers: "stageArchers",
  foot: "stageFoot",
  cavalry: "stageCavalry",
  walls: "stageWalls",
};

/* ------------------------------------------------------------------ */
/* Components                                                          */
/* ------------------------------------------------------------------ */

function GameButton(props: {
  testId: string;
  label: string;
  detail?: string;
  disabled: boolean;
  warning?: string;
  onClick: () => void;
  variant?: "primary" | "plain";
}) {
  return (
    <div className="btn-wrap">
      <button
        type="button"
        data-testid={props.testId}
        className={`btn ${props.variant === "plain" ? "btn-plain" : ""}`}
        disabled={props.disabled}
        onClick={props.onClick}
      >
        <span className="btn-label">{props.label}</span>
        {props.detail ? (
          <span className="btn-detail">{props.detail}</span>
        ) : null}
      </button>
      {props.warning ? (
        <p className="warn" role="status">
          {props.warning}
        </p>
      ) : null}
    </div>
  );
}

function StrengthBar(props: {
  value: number;
  scale: number;
  label: string;
  tone: "olive" | "gold" | "brick" | "stone";
  testId?: string;
}) {
  const pct = props.scale > 0 ? Math.min(100, (props.value / props.scale) * 100) : 0;
  return (
    <div
      className="bar"
      role="progressbar"
      aria-label={props.label}
      aria-valuemin={0}
      aria-valuemax={props.scale}
      aria-valuenow={props.value}
      data-testid={props.testId}
    >
      <div className={`bar-fill tone-${props.tone}`} style={{ width: `${pct}%` }} />
    </div>
  );
}

const STAGE_TONE: Record<StageKey, "olive" | "gold" | "brick" | "stone"> = {
  archers: "olive",
  foot: "gold",
  cavalry: "brick",
  walls: "stone",
};

function BattleLog({ report, t }: { report: BattleReport | null; t: Dict }) {
  return (
    <section className="panel" data-testid="battle-log" aria-labelledby="battle-title">
      <h2 id="battle-title">{t.battleTitle}</h2>
      {!report ? (
        <p className="muted" data-testid="battle-empty">
          {fmt(t.battleEmpty, { n: RAID_EVERY })}
        </p>
      ) : (
        <BattleBody report={report} t={t} />
      )}
    </section>
  );
}

function BattleBody({ report, t }: { report: BattleReport; t: Dict }) {
  const scale = Math.max(report.threat, report.defense, 1);
  const casualtyParts = UNITS.filter((u) => report.casualties[u] > 0).map(
    (u) => `${t[u]}: ${report.casualties[u]}`,
  );

  return (
    <div>
      <p className="muted" data-testid="battle-subtitle">
        {fmt(t.battleSubtitle, { n: report.raidNumber, turn: report.turn })}
      </p>

      <div className="totals">
        <div className="total">
          <span className="total-label">{t.threat}</span>
          <strong className="total-value threat" data-testid="battle-threat">
            {report.threat}
          </strong>
        </div>
        <div className="total">
          <span className="total-label">{t.defenseTotal}</span>
          <strong className="total-value" data-testid="battle-defense">
            {report.defense}
          </strong>
        </div>
      </div>
      <StrengthBar
        value={report.threat}
        scale={scale}
        tone="brick"
        label={t.threat}
        testId="battle-threat-bar"
      />
      <StrengthBar
        value={report.defense}
        scale={scale}
        tone="olive"
        label={t.defenseTotal}
        testId="battle-defense-bar"
      />

      <ol className="stages">
        {report.stages.map((st) => (
          <li
            key={st.key}
            className="stage"
            data-testid={`battle-stage-${st.key}`}
          >
            <div className="stage-head">
              <span className="stage-name">{t[STAGE_LABEL[st.key]]}</span>
              <span
                className="stage-strength"
                data-testid={`battle-stage-${st.key}-strength`}
              >
                {fmt(t.strengthLabel, { n: st.strength })}
              </span>
            </div>
            <StrengthBar
              value={st.strength}
              scale={scale}
              tone={STAGE_TONE[st.key]}
              label={t[STAGE_LABEL[st.key]]}
              testId={`battle-stage-${st.key}-bar`}
            />
            <p
              className={`stage-detail ${st.count === 0 ? "is-zero" : ""}`}
              data-testid={`battle-stage-${st.key}-detail`}
            >
              {st.count === 0
                ? t.stageZero
                : fmt(st.key === "walls" ? t.stageDetailWalls : t.stageDetailUnits, {
                    count: st.count,
                    mult: st.mult,
                  })}
            </p>
          </li>
        ))}

        <li
          className={`stage stage-result ${report.won ? "won" : "lost"}`}
          data-testid="battle-stage-result"
        >
          <div className="stage-head">
            <span className="stage-name">{t.stageResult}</span>
            <span className="result-badge" data-testid="battle-result">
              {report.won ? t.resultWon : t.resultLost}
            </span>
          </div>
          <p className="stage-detail">
            {fmt(t.defenseVsThreat, {
              defense: report.defense,
              threat: report.threat,
            })}
          </p>
          {report.won ? (
            <p className="result-line" data-testid="battle-reward">
              {t.rewardLabel}: {report.reward} {t.gold}
            </p>
          ) : (
            <p className="result-line" data-testid="battle-casualties">
              {t.casualtiesLabel}:{" "}
              {casualtyParts.length > 0
                ? casualtyParts.join(t.listSep)
                : t.casualtiesNone}
            </p>
          )}
          <p className="result-line" data-testid="battle-remaining">
            {t.remainingLabel}: {report.remaining}
          </p>
        </li>
      </ol>
    </div>
  );
}

export default function App() {
  const [lang, setLang] = useState<Lang>("en");
  const [game, setGame] = useState<Game>(newGame);
  const t = dict[lang];
  const dir = lang === "ar" ? "rtl" : "ltr";

  useEffect(() => {
    document.documentElement.lang = lang;
    document.documentElement.dir = dir;
    document.title = t.title;
  }, [lang, dir, t.title]);

  const act = (a: Action) => setGame((g) => applyAction(g, a));
  const over = game.status !== "playing";
  const units = sumUnits(game.army);
  const income = totalIncome(game.plots);
  const nextRaidTurn = Math.ceil(game.turn / RAID_EVERY) * RAID_EVERY;
  const statusLabel =
    game.status === "victory"
      ? t.statusVictory
      : game.status === "defeat"
        ? t.statusDefeat
        : t.statusPlaying;

  const upCost = game.level < MAX_LEVEL ? upgradeCost(game.level) : null;
  const upAffordable = upCost ? canAfford(game.res, upCost) : false;

  return (
    <div className="app">
      <div className="topbar">
        <button
          type="button"
          className="lang-toggle"
          data-testid="language-toggle"
          aria-label={t.langToggleAria}
          onClick={() => setLang(lang === "en" ? "ar" : "en")}
        >
          {t.langToggle}
        </button>
      </div>

      <main
        className="surface"
        lang={lang}
        dir={dir}
        data-testid="game-surface"
        data-lang={lang}
      >
        <header className="hero">
          <h1 data-testid="game-title">{t.title}</h1>
          <p className="muted">{t.tagline}</p>
          <p className="goal" data-testid="game-goal">
            {fmt(t.goal, { level: MAX_LEVEL, units: WIN_UNITS, turns: MAX_TURNS })}
          </p>
        </header>

        <section className="status-strip" aria-label={t.statusLabel}>
          <div>
            <strong data-testid="turn-counter">
              {fmt(t.turnCounter, { turn: game.turn, max: MAX_TURNS })}
            </strong>
          </div>
          <div>
            <span className="total-label">{t.statusLabel}</span>{" "}
            <strong
              className={`status status-${game.status}`}
              data-testid="campaign-status"
            >
              {statusLabel}
            </strong>
          </div>
          {!over ? (
            <div className="muted" data-testid="next-raid">
              {fmt(t.nextRaid, { turn: nextRaidTurn })}
            </div>
          ) : null}
        </section>

        {over ? (
          <section
            className={`panel end-banner end-${game.status}`}
            data-testid="campaign-end"
            role="status"
          >
            <p>
              {game.status === "victory"
                ? t.victoryMsg
                : fmt(t.defeatMsg, { max: MAX_TURNS })}
            </p>
          </section>
        ) : null}

        <div className="grid">
          <section className="panel" aria-labelledby="res-title">
            <h2 id="res-title">{t.resources}</h2>
            <ul className="resources">
              {RESOURCES.map((r) => (
                <li key={r} className={`resource res-${r}`}>
                  <span className="resource-name">{t[r]}</span>
                  <strong data-testid={`resource-${r}`}>{game.res[r]}</strong>
                </li>
              ))}
            </ul>
            <p className="muted" data-testid="income-summary">
              {t.income}: {bagText(income, t, true)}
            </p>
            <p className="muted small" data-testid="income-base">
              {fmt(t.incomeBase, { prod: bagText(BASE_INCOME, t, true) })}
            </p>
          </section>

          <section className="panel" aria-labelledby="castle-title">
            <h2 id="castle-title">{t.castle}</h2>
            <p className="big">
              <span className="total-label">{t.castleLevel}</span>{" "}
              <strong data-testid="castle-level">
                {fmt(t.castleLevelValue, { level: game.level, max: MAX_LEVEL })}
              </strong>
            </p>
            <p className="muted small">
              {fmt(t.wallsNote, { n: WALL_PER_LEVEL })}
            </p>
            {upCost ? (
              <GameButton
                testId="upgrade-castle"
                label={fmt(t.upgradeCastle, { level: game.level + 1 })}
                detail={fmt(t.costLabel, { cost: bagText(upCost, t, false) })}
                disabled={over || !upAffordable}
                warning={!over && !upAffordable ? t.warnFunds : undefined}
                onClick={() => act({ type: "upgrade" })}
              />
            ) : (
              <p className="muted" data-testid="castle-max">
                {t.castleMax}
              </p>
            )}
          </section>
        </div>

        <section className="panel" aria-labelledby="plots-title">
          <h2 id="plots-title">{t.plots}</h2>
          <p className="muted small">{t.plotsNote}</p>
          <div className="plots">
            {game.plots.map((plot, i) => (
              <div className="plot" key={i} data-testid={`plot-${i}`}>
                <h3>{fmt(t.plotLabel, { n: i + 1 })}</h3>
                {plot ? (
                  <div data-testid={`plot-${i}-building`}>
                    <p className="plot-built">{t[plot]}</p>
                    <p className="muted small">
                      {fmt(t.producesLabel, {
                        prod: bagText(BUILDINGS[plot].income, t, true),
                      })}
                    </p>
                  </div>
                ) : (
                  <div>
                    <p className="muted small">{t.plotEmpty}</p>
                    {BUILDING_KEYS.map((b) => {
                      const ok = canAfford(game.res, BUILDINGS[b].cost);
                      return (
                        <div key={b} className="build-option">
                          <p className="muted small">
                            {t[`${b}Desc` as "marketDesc" | "gardenDesc"]}
                          </p>
                          <p className="muted small">
                            {fmt(t.producesLabel, {
                              prod: bagText(BUILDINGS[b].income, t, true),
                            })}
                          </p>
                          <GameButton
                            testId={`build-${b}-${i}`}
                            label={fmt(t.buildBtn, { building: t[b] })}
                            detail={fmt(t.costLabel, {
                              cost: bagText(BUILDINGS[b].cost, t, false),
                            })}
                            disabled={over || !ok}
                            warning={!over && !ok ? t.warnFunds : undefined}
                            onClick={() =>
                              act({ type: "build", plot: i, building: b })
                            }
                          />
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            ))}
          </div>
        </section>

        <section className="panel" aria-labelledby="army-title">
          <h2 id="army-title">{t.army}</h2>
          <p className="muted" data-testid="army-total">
            {fmt(t.totalUnits, { n: units })}
          </p>
          <div className="units">
            {UNITS.map((u) => {
              const cost = UNIT_DATA[u].cost;
              const ok = canAfford(game.res, cost);
              return (
                <div className="unit" key={u} data-testid={`unit-${u}`}>
                  <h3>{t[u]}</h3>
                  <p className="unit-count" data-testid={`army-${u}`}>
                    {fmt(t.unitCount, { n: game.army[u] })}
                  </p>
                  <p className="muted small">
                    {fmt(t.unitStrength, { n: UNIT_DATA[u].strength })}
                  </p>
                  <GameButton
                    testId={`recruit-${u}`}
                    label={fmt(t.recruitBtn, { unit: t[u] })}
                    detail={fmt(t.costLabel, { cost: bagText(cost, t, false) })}
                    disabled={over || !ok}
                    warning={!over && !ok ? t.warnFunds : undefined}
                    onClick={() => act({ type: "recruit", unit: u })}
                  />
                </div>
              );
            })}
          </div>
        </section>

        <section className="panel actions">
          <GameButton
            testId="rest-turn"
            label={t.rest}
            detail={t.restDesc}
            disabled={over}
            warning={over ? t.warnOver : undefined}
            onClick={() => act({ type: "rest" })}
          />
          <GameButton
            testId="new-campaign"
            label={t.newCampaign}
            disabled={false}
            variant="plain"
            onClick={() => setGame(newGame())}
          />
        </section>

        <BattleLog report={game.report} t={t} />

        <section className="panel" aria-labelledby="chron-title">
          <h2 id="chron-title">{t.chronicle}</h2>
          <ol className="chronicle" data-testid="chronicle">
            {[...game.log].reverse().map((e) => (
              <li key={e.id} data-testid={`chronicle-entry-${e.id}`}>
                {eventText(e, t)}
              </li>
            ))}
          </ol>
        </section>
      </main>
    </div>
  );
}
