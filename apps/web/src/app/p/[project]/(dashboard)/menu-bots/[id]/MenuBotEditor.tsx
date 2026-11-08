"use client";

import { useMemo, useRef, useState, useTransition } from "react";
import { ArrowDown, ArrowUp, CircleAlert, CornerDownRight, ListTree, MessageSquareText, Pause, Play, Plus, RotateCcw, Trash2, UserRound, X, type LucideIcon } from "lucide-react";
import {
  advanceMenu,
  MAX_MENU_LABEL,
  MAX_MENU_OPTIONS,
  MAX_MENU_TEXT,
  MAX_MENU_TITLE,
  MENU_BOT_CHANNEL_LABEL,
  MENU_BOT_CHANNELS,
  MENU_NODE_KIND_LABEL,
  MENU_NODE_KINDS,
  menuTreeProblems,
  readMenuKeywords,
  startMenu,
  type MenuBotChannel,
  type MenuBotWording,
  type MenuNode,
  type MenuNodeKind,
  type MenuSessionState,
  type MenuTree,
} from "@support-automation/shared";
import { Alert, Badge, Button, Card, Checkbox, Field, Input, RowMenu, Select, Textarea, useToast } from "@/components/ui";
import { useProjectRouter } from "@/components/ProjectLink";
import { deleteMenuBot, saveMenuBot, setMenuBotStatus } from "@/server/actions/menuBots";
import type { MenuBotDetail } from "@/server/menuBots";

const KIND_ICON: Record<MenuNodeKind, LucideIcon> = { MENU: ListTree, ANSWER: MessageSquareText, HANDOFF: UserRound };
const STATUS_LABEL = { DRAFT: "Draft", ACTIVE: "On", PAUSED: "Paused" } as const;
const STATUS_COLOR = { DRAFT: "gray", ACTIVE: "green", PAUSED: "yellow" } as const;

let nextId = 0;
const newNodeId = () => `n${Date.now().toString(36)}${(nextId += 1)}`;

/** Steps in the order a customer meets them, then anything no choice leads to. */
function outline(tree: MenuTree): { rows: Array<{ node: MenuNode; depth: number }>; loose: MenuNode[] } {
  const seen = new Set<string>();
  const rows: Array<{ node: MenuNode; depth: number }> = [];
  const walk = (id: string, depth: number) => {
    const node = tree.nodes[id];
    if (!node || seen.has(id)) return;
    seen.add(id);
    rows.push({ node, depth });
    for (const option of node.options) walk(option.goTo, depth + 1);
  };
  walk(tree.rootId, 0);
  return { rows, loose: Object.values(tree.nodes).filter((n) => !seen.has(n.id)) };
}

export function MenuBotEditor({ bot, canEdit, canActivate, canDelete }: { bot: MenuBotDetail; canEdit: boolean; canActivate: boolean; canDelete: boolean }) {
  const router = useProjectRouter();
  const { showToast } = useToast();
  const [name, setName] = useState(bot.name);
  const [tree, setTree] = useState<MenuTree>(bot.tree);
  const [selectedId, setSelectedId] = useState(bot.tree.rootId);
  const [keywords, setKeywords] = useState(bot.keywords.join(", "));
  const [firstMessage, setFirstMessage] = useState(bot.startOnFirstMessage);
  const [personal, setPersonal] = useState(bot.onWhatsAppPersonal);
  const [groups, setGroups] = useState(bot.onWhatsAppGroups);
  const [channels, setChannels] = useState<MenuBotChannel[]>(bot.channels);
  const [wording, setWording] = useState<MenuBotWording>({ invalidText: bot.invalidText, handoffText: bot.handoffText, backLabel: bot.backLabel, homeLabel: bot.homeLabel, maxInvalid: bot.maxInvalid });
  const [sessionMinutes, setSessionMinutes] = useState(bot.sessionMinutes);
  const [quietMinutes, setQuietMinutes] = useState(bot.quietMinutes);
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [pending, start] = useTransition();

  const node = tree.nodes[selectedId] ?? tree.nodes[tree.rootId]!;
  const problems = useMemo(() => menuTreeProblems(tree), [tree]);
  const { rows, loose } = useMemo(() => outline(tree), [tree]);

  const touch = () => setDirty(true);
  const updateNode = (id: string, change: Partial<MenuNode>) => {
    touch();
    setTree((t) => ({ ...t, nodes: { ...t.nodes, [id]: { ...t.nodes[id]!, ...change } } }));
  };

  const addChoice = () => {
    if (node.options.length >= MAX_MENU_OPTIONS) return;
    const id = newNodeId();
    touch();
    setTree((t) => ({
      ...t,
      nodes: {
        ...t.nodes,
        [id]: { id, title: `Choice ${node.options.length + 1}`, text: "", kind: "ANSWER", options: [] },
        [node.id]: { ...t.nodes[node.id]!, options: [...t.nodes[node.id]!.options, { label: "", goTo: id }] },
      },
    }));
  };

  const moveChoice = (index: number, delta: number) => {
    const options = [...node.options];
    const [item] = options.splice(index, 1);
    options.splice(index + delta, 0, item!);
    updateNode(node.id, { options });
  };

  const setKind = (kind: MenuNodeKind) => updateNode(node.id, { kind, options: kind === "MENU" ? node.options : [] });

  const removeNode = () => {
    if (node.id === tree.rootId) return;
    touch();
    setTree((t) => {
      const nodes = { ...t.nodes };
      delete nodes[node.id];
      for (const [id, n] of Object.entries(nodes)) if (n.options.some((o) => o.goTo === node.id)) nodes[id] = { ...n, options: n.options.filter((o) => o.goTo !== node.id) };
      return { ...t, nodes };
    });
    setSelectedId(tree.rootId);
  };

  const payload = () => ({ name, tree, keywords: readMenuKeywords(keywords), startOnFirstMessage: firstMessage, onWhatsAppPersonal: personal, onWhatsAppGroups: groups, channels, ...wording, sessionMinutes, quietMinutes });

  const save = () =>
    start(async () => {
      const r = await saveMenuBot(bot.id, payload());
      if ("error" in r) {
        setError(r.error);
        return;
      }
      setError(null);
      setDirty(false);
      showToast({ tone: "success", title: "Saved" });
      router.refresh();
    });

  const setStatus = (status: "ACTIVE" | "PAUSED") =>
    start(async () => {
      if (dirty) {
        const saved = await saveMenuBot(bot.id, payload());
        if ("error" in saved) {
          setError(saved.error);
          return;
        }
        setDirty(false);
      }
      const r = await setMenuBotStatus(bot.id, status);
      if ("error" in r) {
        setError(r.error);
        return;
      }
      setError(null);
      showToast({ tone: "success", title: status === "ACTIVE" ? "The bot is on" : "The bot is paused" });
      router.refresh();
    });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2.5">
        <input value={name} disabled={!canEdit} onChange={(e) => (setName(e.target.value), touch())} maxLength={120} aria-label="Bot name" className="min-w-0 flex-1 rounded-[var(--radius-md)] bg-transparent px-1 py-0.5 text-[22px] font-semibold tracking-[-0.01em] outline-none hover:bg-[var(--color-neutral-bg)] focus:bg-[var(--color-neutral-bg)]" />
        <Badge color={STATUS_COLOR[bot.status]}>{STATUS_LABEL[bot.status]}</Badge>
        {canEdit ? (
          <Button variant="secondary" onClick={save} disabled={pending || !dirty}>
            {pending ? "Saving…" : dirty ? "Save" : "Saved"}
          </Button>
        ) : null}
        {canActivate ? (
          bot.status === "ACTIVE" ? (
            <Button variant="secondary" onClick={() => setStatus("PAUSED")} disabled={pending}>
              <Pause className="size-4" aria-hidden />
              Pause
            </Button>
          ) : (
            <Button onClick={() => setStatus("ACTIVE")} disabled={pending || problems.length > 0}>
              <Play className="size-4" aria-hidden />
              Switch on
            </Button>
          )
        ) : null}
        {canDelete ? (
          <RowMenu
            horizontal
            items={[
              {
                label: "Delete",
                icon: <Trash2 className="size-3.5" />,
                danger: true,
                onSelect: () => {
                  if (!window.confirm(`Delete ${bot.name} and its history? This cannot be undone.`)) return;
                  start(async () => {
                    const r = await deleteMenuBot(bot.id);
                    if ("error" in r) setError(r.error);
                    else router.push("/menu-bots");
                  });
                },
              },
            ]}
          />
        ) : null}
      </div>

      {error ? <Alert tone="danger">{error}</Alert> : null}
      {bot.status !== "ACTIVE" && problems.length ? (
        <div className="rounded-[var(--radius-md)] border border-[var(--color-warning-border)] bg-[var(--color-warning-bg)] px-3.5 py-2.5 text-[13px] text-[color:var(--color-warning-fg)]">
          <p className="flex items-center gap-1.5 font-medium">
            <CircleAlert className="size-4" aria-hidden />
            Finish these before switching it on
          </p>
          <ul className="mt-1 list-inside list-disc space-y-0.5">
            {problems.slice(0, 6).map((p) => (
              <li key={p}>{p}</li>
            ))}
            {problems.length > 6 ? <li>and {problems.length - 6} more</li> : null}
          </ul>
        </div>
      ) : null}

      <div className="grid gap-4 xl:grid-cols-[17rem_minmax(0,1fr)_20rem]">
        <Card className="min-w-0 self-start p-2">
          <p className="px-2 pb-1 pt-1.5 text-[12px] font-medium text-[color:var(--color-muted-foreground)]">Steps</p>
          <ul className="max-h-[32rem] overflow-y-auto">
            {rows.map(({ node: n, depth }) => (
              <StepRow key={n.id} node={n} depth={depth} selected={n.id === node.id} onSelect={() => setSelectedId(n.id)} />
            ))}
            {loose.length ? <li className="px-2 pb-1 pt-2.5 text-[12px] font-medium text-[color:var(--color-warning-fg)]">Not linked from any menu</li> : null}
            {loose.map((n) => (
              <StepRow key={n.id} node={n} depth={0} selected={n.id === node.id} onSelect={() => setSelectedId(n.id)} />
            ))}
          </ul>
        </Card>

        <Card className="min-w-0 space-y-3.5 self-start p-4">
          <fieldset disabled={!canEdit} className="min-w-0 space-y-3.5">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Step name" hint="For your team. Customers do not see it.">
                <Input value={node.title} maxLength={MAX_MENU_TITLE} onChange={(e) => updateNode(node.id, { title: e.target.value })} />
              </Field>
              <Field label="What this step does">
                <Select value={node.kind} disabled={node.id === tree.rootId} onChange={(e) => setKind(e.target.value as MenuNodeKind)}>
                  {MENU_NODE_KINDS.map((k) => (
                    <option key={k} value={k}>
                      {MENU_NODE_KIND_LABEL[k]}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            <Field label="Message">
              <Textarea value={node.text} rows={4} maxLength={MAX_MENU_TEXT} onChange={(e) => updateNode(node.id, { text: e.target.value })} />
            </Field>

            {node.kind === "MENU" ? (
              <div>
                <p className="mb-1.5 text-[13px] font-medium">Choices</p>
                <ul className="space-y-1.5">
                  {node.options.map((option, i) => (
                    <li key={`${i}-${option.goTo}`} className="flex flex-wrap items-center gap-1.5 sm:flex-nowrap">
                      <span className="tabular w-5 shrink-0 text-center text-[13px] font-semibold text-[color:var(--color-muted-foreground)]">{i + 1}</span>
                      <input
                        value={option.label}
                        maxLength={MAX_MENU_LABEL}
                        placeholder="What the customer sees"
                        onChange={(e) => updateNode(node.id, { options: node.options.map((o, n) => (n === i ? { ...o, label: e.target.value } : o)) })}
                        className="min-w-0 flex-1 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-[13.5px]"
                      />
                      <Select aria-label={`Where choice ${i + 1} leads`} value={option.goTo} onChange={(e) => updateNode(node.id, { options: node.options.map((o, n) => (n === i ? { ...o, goTo: e.target.value } : o)) })} className="w-40 shrink-0">
                        {Object.values(tree.nodes).map((n) => (
                          <option key={n.id} value={n.id}>
                            {n.title || "Untitled step"}
                          </option>
                        ))}
                      </Select>
                      <IconButton label="Open that step" icon={CornerDownRight} onClick={() => setSelectedId(option.goTo)} />
                      <IconButton label="Move up" icon={ArrowUp} disabled={i === 0} onClick={() => moveChoice(i, -1)} />
                      <IconButton label="Move down" icon={ArrowDown} disabled={i === node.options.length - 1} onClick={() => moveChoice(i, 1)} />
                      <IconButton label="Remove choice" icon={X} onClick={() => updateNode(node.id, { options: node.options.filter((_, n) => n !== i) })} />
                    </li>
                  ))}
                </ul>
                <Button size="sm" variant="secondary" className="mt-2" disabled={node.options.length >= MAX_MENU_OPTIONS} onClick={addChoice}>
                  <Plus className="size-3.5" aria-hidden />
                  Add a choice
                </Button>
              </div>
            ) : null}

            {node.id !== tree.rootId ? (
              <button type="button" onClick={removeNode} className="inline-flex items-center gap-1.5 text-[12.5px] text-[color:var(--color-muted-foreground)] hover:text-[color:var(--color-danger-fg)]">
                <Trash2 className="size-3.5" aria-hidden />
                Delete this step
              </button>
            ) : null}
          </fieldset>
        </Card>

        <TestPanel tree={tree} wording={wording} keywords={readMenuKeywords(keywords)} />
      </div>

      <Card className="p-4">
        <fieldset disabled={!canEdit} className="grid min-w-0 gap-x-6 gap-y-4 lg:grid-cols-2">
          <div className="space-y-3">
            <h2 className="text-[14px] font-semibold">When it starts</h2>
            <Field label="Start words" hint="The whole message must be one of these. Separate with commas.">
              <Input value={keywords} onChange={(e) => (setKeywords(e.target.value), touch())} />
            </Field>
            <label className="flex items-center gap-2 text-[13px]">
              <Checkbox checked={firstMessage} onChange={(e) => (setFirstMessage(e.target.checked), touch())} />
              Also start on someone&apos;s very first message
            </label>
            <h2 className="pt-1 text-[14px] font-semibold">Where it answers</h2>
            <div className="grid grid-cols-2 gap-2">
              <label className="flex items-center gap-2 text-[13px]">
                <Checkbox checked={personal} onChange={(e) => (setPersonal(e.target.checked), touch())} />
                WhatsApp chats
              </label>
              <label className="flex items-center gap-2 text-[13px]">
                <Checkbox checked={groups} onChange={(e) => (setGroups(e.target.checked), touch())} />
                Monitored groups
              </label>
              {MENU_BOT_CHANNELS.map((c) => (
                <label key={c} className="flex items-center gap-2 text-[13px]">
                  <Checkbox
                    checked={channels.includes(c)}
                    onChange={(e) => {
                      touch();
                      setChannels((list) => (e.target.checked ? [...list, c] : list.filter((x) => x !== c)));
                    }}
                  />
                  {MENU_BOT_CHANNEL_LABEL[c]}
                </label>
              ))}
            </div>
          </div>
          <div className="space-y-3">
            <h2 className="text-[14px] font-semibold">Wording and timing</h2>
            <Field label="When the answer is not one of the numbers">
              <Input value={wording.invalidText} maxLength={500} onChange={(e) => (setWording((w) => ({ ...w, invalidText: e.target.value })), touch())} />
            </Field>
            <Field label="When handing to a person">
              <Input value={wording.handoffText} maxLength={1000} onChange={(e) => (setWording((w) => ({ ...w, handoffText: e.target.value })), touch())} />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Word for back (0)">
                <Input value={wording.backLabel} maxLength={30} onChange={(e) => (setWording((w) => ({ ...w, backLabel: e.target.value })), touch())} />
              </Field>
              <Field label="Word for start (00)">
                <Input value={wording.homeLabel} maxLength={30} onChange={(e) => (setWording((w) => ({ ...w, homeLabel: e.target.value })), touch())} />
              </Field>
              <Field label="Wrong answers before a person">
                <Input type="number" min={1} max={10} value={wording.maxInvalid} onChange={(e) => (setWording((w) => ({ ...w, maxInvalid: Number(e.target.value) })), touch())} />
              </Field>
              <Field label="Forget after (minutes)">
                <Input type="number" min={1} max={1440} value={sessionMinutes} onChange={(e) => (setSessionMinutes(Number(e.target.value)), touch())} />
              </Field>
              <Field label="Quiet after a hand-over (minutes)">
                <Input type="number" min={0} max={10080} value={quietMinutes} onChange={(e) => (setQuietMinutes(Number(e.target.value)), touch())} />
              </Field>
            </div>
          </div>
        </fieldset>
      </Card>
    </div>
  );
}

function IconButton({ label, icon: Icon, onClick, disabled }: { label: string; icon: LucideIcon; onClick: () => void; disabled?: boolean }) {
  return (
    <button type="button" aria-label={label} title={label} onClick={onClick} disabled={disabled} className="flex size-8 shrink-0 items-center justify-center rounded-[var(--radius-md)] text-[color:var(--color-muted-foreground)] hover:bg-[var(--color-neutral-bg)] hover:text-[color:var(--color-foreground)] disabled:opacity-30">
      <Icon className="size-3.5" aria-hidden />
    </button>
  );
}

function StepRow({ node, depth, selected, onSelect }: { node: MenuNode; depth: number; selected: boolean; onSelect: () => void }) {
  const Icon = KIND_ICON[node.kind];
  return (
    <li>
      <button type="button" onClick={onSelect} aria-current={selected ? "true" : undefined} style={{ paddingLeft: `${8 + Math.min(depth, 5) * 14}px` }} className={`flex w-full items-center gap-2 rounded-[var(--radius-md)] py-1.5 pr-2 text-left text-[13px] ${selected ? "bg-[var(--color-accent-bg)] font-medium text-[color:var(--color-accent-fg)]" : "hover:bg-[var(--color-neutral-bg)]"}`}>
        <Icon className="size-3.5 shrink-0 opacity-70" aria-hidden />
        <span className="min-w-0 truncate">{node.title || "Untitled step"}</span>
      </button>
    </li>
  );
}

type Bubble = { from: "customer" | "bot" | "note"; text: string };

/** Answers exactly as the bot will, from the same code, with what is on screen now. Nothing is saved or sent. */
function TestPanel({ tree, wording, keywords }: { tree: MenuTree; wording: MenuBotWording; keywords: string[] }) {
  const [bubbles, setBubbles] = useState<Bubble[]>([]);
  const [state, setState] = useState<MenuSessionState | null>(null);
  const [text, setText] = useState("");
  const scroller = useRef<HTMLDivElement>(null);

  const show = (next: Bubble[]) => {
    setBubbles((b) => [...b, ...next]);
    requestAnimationFrame(() => scroller.current?.scrollTo({ top: scroller.current.scrollHeight }));
  };

  const send = () => {
    const input = text.trim();
    if (!input) return;
    setText("");
    const out: Bubble[] = [{ from: "customer", text: input }];
    const step = state ? advanceMenu(tree, state, input, wording, keywords) : startMenu(tree, wording);
    if (step.action === "RELEASE") {
      out.push({ from: "note", text: "Not a menu answer. This goes on to your rules and AI as usual." });
      setState(null);
    } else {
      out.push({ from: "bot", text: step.reply });
      if (step.status === "HANDED_OFF") {
        out.push({ from: "note", text: "Handed to your team. The bot stays quiet in this chat." });
        setState(null);
      } else {
        setState(step.state);
      }
    }
    show(out);
  };

  return (
    <Card className="flex min-w-0 flex-col self-start overflow-hidden">
      <div className="flex items-center justify-between border-b border-[var(--color-border)] px-3.5 py-2">
        <p className="text-[13px] font-semibold">Try it</p>
        <button
          type="button"
          aria-label="Start over"
          title="Start over"
          onClick={() => {
            setBubbles([]);
            setState(null);
          }}
          className="text-[color:var(--color-muted-foreground)] hover:text-[color:var(--color-foreground)]"
        >
          <RotateCcw className="size-3.5" aria-hidden />
        </button>
      </div>
      <div ref={scroller} className="h-80 space-y-2 overflow-y-auto bg-[var(--color-surface-sunken)] p-3">
        {bubbles.length === 0 ? <p className="pt-24 text-center text-[12.5px] text-[color:var(--color-muted-foreground)]">Type anything to start. Nothing is sent.</p> : null}
        {bubbles.map((b, i) =>
          b.from === "note" ? (
            <p key={i} className="text-center text-[12px] text-[color:var(--color-muted-foreground)]">
              {b.text}
            </p>
          ) : (
            <div key={i} className={`max-w-[88%] whitespace-pre-wrap break-words rounded-[var(--radius-lg)] px-3 py-2 text-[13px] ${b.from === "customer" ? "ml-auto bg-[var(--color-primary)] text-[var(--color-on-primary)]" : "bg-[var(--color-surface)] shadow-sm"}`}>
              {b.text}
            </div>
          ),
        )}
      </div>
      <form
        className="flex gap-2 border-t border-[var(--color-border)] p-2"
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
      >
        <Input value={text} onChange={(e) => setText(e.target.value)} placeholder="Type like a customer" aria-label="Type like a customer" />
        <Button type="submit" size="sm" variant="secondary">
          Send
        </Button>
      </form>
    </Card>
  );
}
