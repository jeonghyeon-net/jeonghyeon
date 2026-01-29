import React, { useState, useCallback, useEffect, useRef, Fragment, useMemo, createContext, useContext } from "react";
import { fetch } from "@tauri-apps/plugin-http";
import { openUrl } from "@tauri-apps/plugin-opener";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { vscDarkPlus } from "react-syntax-highlighter/dist/esm/styles/prism";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";

type Project = {
  id: string;
  key: string;
  name: string;
};

type Issue = {
  id: string;
  key: string;
  summary: string;
  priority: string;
  issueType: string;
  status: string;
  statusCategory: string;
  dueDate: string | null;
};

type Comment = {
  id: string;
  author: string;
  authorId: string;
  body: string;
  created: string;
};

type TimeTracking = {
  originalEstimate: string | null;
  remainingEstimate: string | null;
  timeSpent: string | null;
  originalEstimateSeconds: number | null;
  remainingEstimateSeconds: number | null;
  timeSpentSeconds: number | null;
};

type Worklog = {
  id: string;
  author: string;
  authorId: string;
  timeSpent: string;
  timeSpentSeconds: number;
  comment: string;
  started: string;
  created: string;
};

type IssueDetail = {
  id: string;
  key: string;
  summary: string;
  description: string;
  descriptionRaw: any;
  status: string;
  statusCategory: string;
  priority: string;
  priorityId: string;
  assignee: string;
  assigneeId: string | null;
  reporter: string;
  reporterId: string | null;
  created: string;
  updated: string;
  labels: string[];
  components: string[];
  issueType: string;
  projectKey: string;
  comments: Comment[];
  parentKey: string | null;
  parentSummary: string | null;
  timeTracking: TimeTracking | null;
  worklogs: Worklog[];
  dueDate: string | null;
};

type ProjectFilter = {
  assigneeMe: boolean;
  statuses: string[];
  issueTypes: string[];
  priorityMin: string;
  sortBy: string;
  sortOrder: "ASC" | "DESC";
  jqlExtra: string;
  maxResults: number;
};

type PrCheck = { name: string; status: string; conclusion: string | null; detailsUrl: string; prNumber?: number; duration?: number | null };

type JiraConnection = {
  id: string;
  name: string;
  username: string;
  token: string;
  baseUrl: string;
};

// Code block component for markdown rendering
function CodeBlock({ children, className, ...props }: React.HTMLAttributes<HTMLElement> & { children?: React.ReactNode }) {
  const [copied, setCopied] = useState(false);
  const match = /language-(\w+)/.exec(className || "");
  const isInline = !match && typeof children === "string" && !children.includes("\n");

  const handleCopy = async () => {
    const code = String(children).replace(/\n$/, "");
    await navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  if (isInline) {
    return <code className="inline-code" {...props}>{children}</code>;
  }

  return (
    <div className="code-block-wrapper">
      <div className="code-block-header">
        <span className="code-block-lang">{match ? match[1] : "code"}</span>
        <button className="code-copy-btn" onClick={handleCopy}>
          {copied ? "Copied!" : "Copy"}
        </button>
      </div>
      <SyntaxHighlighter
        style={vscDarkPlus as { [key: string]: React.CSSProperties }}
        language={match ? match[1] : "text"}
        PreTag="div"
        customStyle={{
          margin: 0,
          borderRadius: "0 0 6px 6px",
          fontSize: "13px",
        }}
      >
        {String(children).replace(/\n$/, "")}
      </SyntaxHighlighter>
    </div>
  );
}

function generateConnectionId(): string {
  return `conn_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

function getJiraConnections(): JiraConnection[] {
  const saved = localStorage.getItem("jira_connections");
  if (saved) {
    try {
      return JSON.parse(saved);
    } catch {
      return [];
    }
  }
  return [];
}

function saveJiraConnections(connections: JiraConnection[]) {
  localStorage.setItem("jira_connections", JSON.stringify(connections));
}

function getActiveConnectionId(): string | null {
  return localStorage.getItem("jira_active_connection_id");
}

function setActiveConnectionId(id: string) {
  localStorage.setItem("jira_active_connection_id", id);
}

function getActiveConnection(): JiraConnection | null {
  const connections = getJiraConnections();
  const activeId = getActiveConnectionId();
  if (activeId) {
    const conn = connections.find(c => c.id === activeId);
    if (conn) return conn;
  }
  // Fallback to first connection
  if (connections.length > 0) {
    setActiveConnectionId(connections[0].id);
    return connections[0];
  }
  return null;
}

const defaultFilter: ProjectFilter = {
  assigneeMe: false,
  statuses: [],
  issueTypes: [],
  priorityMin: "",
  sortBy: "created",
  sortOrder: "DESC",
  jqlExtra: "",
  maxResults: 50,
};

function getStoragePrefix(): string {
  const connId = getActiveConnectionId();
  return connId ? `${connId}_` : "";
}

function getProjectFilter(projectKey: string): ProjectFilter {
  const saved = localStorage.getItem(`${getStoragePrefix()}filter_${projectKey}`);
  if (saved) return { ...defaultFilter, ...JSON.parse(saved) };
  return { ...defaultFilter };
}

function saveProjectFilter(projectKey: string, filter: ProjectFilter) {
  localStorage.setItem(`${getStoragePrefix()}filter_${projectKey}`, JSON.stringify(filter));
}

function getProjectKeyFromIssueKey(issueKey: string): string {
  return issueKey.split("-")[0] || "";
}

type WorktreeInfo = {
  path: string;
  branch: string;
  baseBranch?: string;
  repoPath?: string;
};

function getIssueWorktree(projectKey: string, issueKey: string): WorktreeInfo | null {
  const saved = localStorage.getItem(`${getStoragePrefix()}worktree_${projectKey}_${issueKey}`);
  return saved ? JSON.parse(saved) : null;
}

function saveIssueWorktree(projectKey: string, issueKey: string, info: WorktreeInfo) {
  localStorage.setItem(`${getStoragePrefix()}worktree_${projectKey}_${issueKey}`, JSON.stringify(info));
}

function removeIssueWorktree(projectKey: string, issueKey: string) {
  localStorage.removeItem(`${getStoragePrefix()}worktree_${projectKey}_${issueKey}`);
}

function getAllWorktrees(): { key: string; projectKey: string; issueKey: string; info: WorktreeInfo }[] {
  const prefix = getStoragePrefix();
  const worktreePrefix = `${prefix}worktree_`;
  const worktrees: { key: string; projectKey: string; issueKey: string; info: WorktreeInfo }[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key && key.startsWith(worktreePrefix)) {
      const parts = key.replace(worktreePrefix, "").split("_");
      if (parts.length >= 2) {
        const projectKey = parts[0];
        const issueKey = parts.slice(1).join("_");
        const saved = localStorage.getItem(key);
        if (saved) {
          try {
            worktrees.push({ key, projectKey, issueKey, info: JSON.parse(saved) });
          } catch {}
        }
      }
    }
  }
  return worktrees;
}

function getDefaultTerminalFontSize(): number {
  const cssValue = getComputedStyle(document.documentElement).getPropertyValue('--terminal-font-size').trim();
  return cssValue ? parseInt(cssValue, 10) : 12;
}
function getTerminalFontSize(): number {
  return getDefaultTerminalFontSize();
}

function getOpenProjects(): Record<string, boolean> {
  const saved = localStorage.getItem(`${getStoragePrefix()}open_projects`);
  return saved ? JSON.parse(saved) : {};
}

function saveOpenProjects(openProjects: Record<string, boolean>) {
  localStorage.setItem(`${getStoragePrefix()}open_projects`, JSON.stringify(openProjects));
}

// === Theme Management ===
type ThemeConfig = {
  name: string;
  variables: Record<string, string>;
};

// Keyboard shortcuts
type ShortcutKey = "toggleSidebar" | "toggleRightSidebar" | "toggleTerminal" | "maximizeTerminal" | "newTerminalTab" | "newTerminalGroup" | "prevTerminalTab" | "nextTerminalTab" | "closeTerminalTab";

type Shortcut = {
  key: string;
  meta: boolean;
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
};

type ShortcutConfig = Record<ShortcutKey, Shortcut>;

const DEFAULT_SHORTCUTS: ShortcutConfig = {
  toggleSidebar: { key: "b", meta: true, ctrl: false, shift: false, alt: false },
  toggleRightSidebar: { key: "b", meta: true, ctrl: false, shift: false, alt: true },
  toggleTerminal: { key: "j", meta: true, ctrl: false, shift: false, alt: false },
  maximizeTerminal: { key: "escape", meta: false, ctrl: false, shift: true, alt: false },
  newTerminalTab: { key: "t", meta: true, ctrl: false, shift: false, alt: false },
  newTerminalGroup: { key: "\\", meta: true, ctrl: false, shift: false, alt: false },
  prevTerminalTab: { key: "[", meta: true, ctrl: false, shift: true, alt: false },
  nextTerminalTab: { key: "]", meta: true, ctrl: false, shift: true, alt: false },
  closeTerminalTab: { key: "w", meta: true, ctrl: false, shift: false, alt: false },
};

const SHORTCUT_LABELS: Record<ShortcutKey, string> = {
  toggleSidebar: "Toggle Sidebar",
  toggleRightSidebar: "Toggle Right Sidebar",
  toggleTerminal: "Toggle Terminal",
  maximizeTerminal: "Maximize Terminal",
  newTerminalTab: "New Terminal Tab",
  newTerminalGroup: "New Terminal Group",
  prevTerminalTab: "Previous Terminal Tab",
  nextTerminalTab: "Next Terminal Tab",
  closeTerminalTab: "Close",
};

// === Pomodoro Timer ===
type PomodoroMode = "work" | "shortBreak" | "longBreak";

type PomodoroSettings = {
  workDuration: number; // minutes
  shortBreakDuration: number;
  longBreakDuration: number;
  sessionsBeforeLongBreak: number;
  soundEnabled: boolean;
};

const DEFAULT_POMODORO_SETTINGS: PomodoroSettings = {
  workDuration: 25,
  shortBreakDuration: 5,
  longBreakDuration: 15,
  sessionsBeforeLongBreak: 4,
  soundEnabled: true,
};

function getPomodoroSettings(): PomodoroSettings {
  const saved = localStorage.getItem("pomodoro_settings");
  if (saved) {
    try {
      return { ...DEFAULT_POMODORO_SETTINGS, ...JSON.parse(saved) };
    } catch {
      return DEFAULT_POMODORO_SETTINGS;
    }
  }
  return DEFAULT_POMODORO_SETTINGS;
}

function savePomodoroSettings(settings: PomodoroSettings) {
  localStorage.setItem("pomodoro_settings", JSON.stringify(settings));
}

// === Quick Memo ===
function getMemo(connectionId: string | null): string {
  if (!connectionId) return "";
  return localStorage.getItem(`quick_memo_${connectionId}`) || "";
}

function saveMemo(connectionId: string | null, content: string) {
  if (!connectionId) return;
  localStorage.setItem(`quick_memo_${connectionId}`, content);
}

function playNotificationSound() {
  // Create a simple beep sound using Web Audio API
  try {
    const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
    const oscillator = audioContext.createOscillator();
    const gainNode = audioContext.createGain();

    oscillator.connect(gainNode);
    gainNode.connect(audioContext.destination);

    oscillator.frequency.value = 800;
    oscillator.type = "sine";

    gainNode.gain.setValueAtTime(0.3, audioContext.currentTime);
    gainNode.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 0.5);

    oscillator.start(audioContext.currentTime);
    oscillator.stop(audioContext.currentTime + 0.5);

    // Play second beep
    setTimeout(() => {
      const osc2 = audioContext.createOscillator();
      const gain2 = audioContext.createGain();
      osc2.connect(gain2);
      gain2.connect(audioContext.destination);
      osc2.frequency.value = 1000;
      osc2.type = "sine";
      gain2.gain.setValueAtTime(0.3, audioContext.currentTime);
      gain2.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 0.5);
      osc2.start(audioContext.currentTime);
      osc2.stop(audioContext.currentTime + 0.5);
    }, 200);
  } catch (e) {
    console.error("Failed to play notification sound:", e);
  }
}

function getShortcuts(): ShortcutConfig {
  const saved = localStorage.getItem("keyboard_shortcuts");
  if (saved) {
    try {
      return { ...DEFAULT_SHORTCUTS, ...JSON.parse(saved) };
    } catch {
      return DEFAULT_SHORTCUTS;
    }
  }
  return DEFAULT_SHORTCUTS;
}

function saveShortcuts(shortcuts: ShortcutConfig) {
  localStorage.setItem("keyboard_shortcuts", JSON.stringify(shortcuts));
}

function formatShortcut(shortcut: Shortcut): string {
  const parts: string[] = [];
  if (shortcut.meta) parts.push("⌘");
  if (shortcut.ctrl) parts.push("Ctrl");
  if (shortcut.alt) parts.push("⌥");
  if (shortcut.shift) parts.push("⇧");

  let keyDisplay = shortcut.key.toUpperCase();
  if (shortcut.key === "\\") keyDisplay = "\\";
  else if (shortcut.key === "=") keyDisplay = "+";
  else if (shortcut.key === "-") keyDisplay = "-";
  else if (shortcut.key === " ") keyDisplay = "Space";

  parts.push(keyDisplay);
  return parts.join(" + ");
}

const THEME_ADJECTIVES = ["Cosmic", "Neon", "Midnight", "Ocean", "Forest", "Solar", "Lunar", "Arctic", "Sunset", "Dawn", "Mystic", "Electric", "Velvet", "Crystal", "Shadow"];
const THEME_NOUNS = ["Dream", "Horizon", "Pulse", "Wave", "Glow", "Storm", "Frost", "Blaze", "Mist", "Echo", "Spark", "Shade", "Flux", "Drift", "Aura"];

function generateRandomThemeName(): string {
  const adj = THEME_ADJECTIVES[Math.floor(Math.random() * THEME_ADJECTIVES.length)];
  const noun = THEME_NOUNS[Math.floor(Math.random() * THEME_NOUNS.length)];
  return `${adj} ${noun}`;
}

// key를 code로 변환 (e.code는 물리적 키 위치라 한/영, modifier 영향 안받음)
function keyToCode(key: string): string {
  if (/^[a-z]$/i.test(key)) return `Key${key.toUpperCase()}`;
  if (/^[0-9]$/.test(key)) return `Digit${key}`;
  const specialKeys: Record<string, string> = {
    "\\": "Backslash", "[": "BracketLeft", "]": "BracketRight",
    "=": "Equal", "-": "Minus", "'": "Quote", ";": "Semicolon",
    ",": "Comma", ".": "Period", "/": "Slash", "`": "Backquote",
    " ": "Space", "enter": "Enter", "tab": "Tab", "escape": "Escape",
    "backspace": "Backspace", "delete": "Delete",
    "arrowup": "ArrowUp", "arrowdown": "ArrowDown",
    "arrowleft": "ArrowLeft", "arrowright": "ArrowRight",
  };
  return specialKeys[key.toLowerCase()] || key;
}

function matchesShortcut(e: KeyboardEvent, shortcut: Shortcut): boolean {
  const expectedCode = keyToCode(shortcut.key);
  // e.code로 비교 (한/영 전환, Option 키 영향 안받음)
  const keyMatches = e.code === expectedCode ||
    (shortcut.key === "=" && (e.code === "Equal" || e.code === "NumpadAdd"));

  return keyMatches &&
    (shortcut.meta ? e.metaKey : !e.metaKey || shortcut.ctrl) &&
    (shortcut.ctrl ? e.ctrlKey : !e.ctrlKey || shortcut.meta) &&
    (shortcut.shift ? e.shiftKey : !e.shiftKey) &&
    (shortcut.alt ? e.altKey : !e.altKey);
}

const DEFAULT_THEME_NAME = "Default Dark";

// Default theme CSS template with comments
const DEFAULT_THEME_TEMPLATE = `/* Theme: My Custom Theme */
/* Generated by jeonghyeon */
/* 이 파일을 수정하여 커스텀 테마를 만들 수 있습니다 */

:root {
  /* === 배경 색상 (Background Colors) === */
  /* 앱의 주요 배경색 */
  --bg-primary: #1f1f1f;
  /* 카드, 팝오버 등의 보조 배경색 */
  --bg-secondary: #262626;
  /* 체크박스, 칩 등의 활성 배경색 */
  --bg-tertiary: #2e2e2e;
  /* 호버 시 배경색 */
  --bg-hover: rgba(255, 255, 255, 0.05);
  /* 선택된 아이템 배경색 */
  --bg-selected: rgba(255, 255, 255, 0.08);
  --bg-selected-hover: rgba(255, 255, 255, 0.12);
  /* 코드 블록 배경색 */
  --bg-code: rgba(255, 255, 255, 0.05);
  --bg-pre: rgba(0, 0, 0, 0.2);
  --bg-blockquote: rgba(255, 255, 255, 0.02);
  --bg-table-header: rgba(255, 255, 255, 0.03);
  --bg-table-hover: rgba(255, 255, 255, 0.02);
  --bg-skeleton: rgba(255, 255, 255, 0.04);
  --bg-input: rgba(255, 255, 255, 0.03);

  /* === 테두리 색상 (Border Colors) === */
  /* 기본 테두리 */
  --border: #333333;
  /* 호버 시 테두리 */
  --border-hover: #444444;
  /* 포커스 시 테두리 */
  --border-focus: #555555;

  /* === 텍스트 색상 (Text Colors) === */
  /* 주요 텍스트 */
  --text: #b4b4b4;
  /* 보조 텍스트, 레이블 */
  --text-muted: #7a7a7a;
  /* 플레이스홀더 텍스트 */
  --text-placeholder: #5a5a5a;
  /* 강조 텍스트 */
  --text-bright: #d4d4d4;

  /* === 액센트 색상 (Accent Colors) === */
  /* 기본 액센트 (버튼, 링크 등) */
  --accent: #4078c0;
  /* 액센트 호버 */
  --accent-hover: #3568a8;
  /* 밝은 액센트 (링크 텍스트) */
  --accent-light: #5088d0;

  /* === 상태 색상 (Status Colors) === */
  --success: #4ec46a;
  --success-dark: #3a9a52;
  --error: #e55a5a;
  --error-light: #f09090;
  --warning: #c9a344;

  /* === PR 상태 색상 (PR Status Colors) === */
  --pr-open: #5eba70;
  --pr-open-bg: rgba(94, 186, 112, 0.12);
  --pr-open-bg-hover: rgba(94, 186, 112, 0.2);
  --pr-merged: #a78bda;
  --pr-merged-bg: rgba(167, 139, 218, 0.12);
  --pr-merged-bg-hover: rgba(167, 139, 218, 0.2);
  --pr-closed: #d66d6d;
  --pr-closed-bg: rgba(214, 109, 109, 0.12);
  --pr-closed-bg-hover: rgba(214, 109, 109, 0.2);
  --pr-draft: #8a8a8a;
  --pr-draft-bg: rgba(138, 138, 138, 0.12);
  --pr-draft-bg-hover: rgba(138, 138, 138, 0.2);

  /* === 우선순위 색상 (Priority Colors) === */
  --priority-highest: #d66d6d;
  --priority-high: #d98f55;
  --priority-medium: #c9a344;
  --priority-low: #5eba70;
  --priority-lowest: #5aa8b8;
  --priority-default: #7a7a7a;

  /* === 타이포그래피 (Typography) === */
  /* 기본 폰트 (앱 전체) */
  --font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  /* 코드/터미널 폰트 */
  --font-family-mono: "SF Mono", ui-monospace, "Cascadia Code", "Fira Code", Consolas, monospace;
  /* 기본 폰트 크기 */
  --font-size-base: 12px;

  /* 폰트 크기 스케일 (전체 조절 가능) */
  --font-size-2xs: 9px;
  --font-size-xs: 10px;
  --font-size-sm: 11px;
  --font-size-md: 12px;
  --font-size-lg: 13px;
  --font-size-xl: 14px;
  --font-size-2xl: 16px;
  --font-size-3xl: 18px;

  /* 아이콘 크기 스케일 */
  --icon-size-xs: 10px;
  --icon-size-sm: 12px;
  --icon-size-md: 14px;
  --icon-size-lg: 16px;
  --icon-size-xl: 20px;
  --icon-size-2xl: 24px;
  --icon-size-3xl: 48px;

  /* === 위험/에러 배경 (Danger/Error Backgrounds) === */
  --error-bg: rgba(214, 109, 109, 0.1);
  --error-bg-hover: rgba(214, 109, 109, 0.18);
  --error-border: rgba(214, 109, 109, 0.25);
  --error-border-hover: rgba(214, 109, 109, 0.4);

  /* === 기타 배경 (Other Backgrounds) === */
  --bg-header: rgba(0, 0, 0, 0.12);
  --bg-active-tab: rgba(255, 255, 255, 0.06);

  /* === 사이드바 (Sidebar) === */
  --sidebar-header-font-size: 11px;
  --sidebar-item-height: 26px;
  --sidebar-item-font-size: 12px;
  --sidebar-item-padding: 0 6px;
  --sidebar-icon-size: 14px;
  --sidebar-issue-count-font-size: 11px;

  /* === 이슈 디테일 (Issue Detail) === */
  --issue-title-font-size: 18px;
  --issue-key-font-size: 11px;
  --issue-meta-label-font-size: 10px;
  --issue-meta-value-font-size: 12px;
  --issue-description-font-size: 13px;

  /* === 터미널 (Terminal) === */
  --terminal-bg: #1f1f1f;
  --terminal-fg: #b4b4b4;
  --terminal-cursor: #b4b4b4;
  /* 터미널 내용 폰트 크기 (단위 없이 숫자만) */
  --terminal-font-size: 11;
  --terminal-tab-font-size: 11px;

  /* 터미널 ANSI 색상 (Terminal restart required) */
  --terminal-black: #1f1f1f;
  --terminal-bright-black: #5a5a5a;
  --terminal-white: #b4b4b4;
  --terminal-bright-white: #d4d4d4;
  --terminal-blue: #4078c0;
  --terminal-bright-blue: #5088d0;
  --terminal-cyan: #5aa8b8;
  --terminal-bright-cyan: #78bcc8;
  --terminal-green: #5eba70;
  --terminal-bright-green: #80d090;
  --terminal-magenta: #a78bda;
  --terminal-bright-magenta: #c0a8e8;
  --terminal-red: #d66d6d;
  --terminal-bright-red: #e89090;
  --terminal-yellow: #c9a344;
  --terminal-bright-yellow: #dfc070;
}
`;

function getCurrentThemeName(): string {
  return localStorage.getItem("current_theme") || DEFAULT_THEME_NAME;
}

function saveCurrentThemeName(name: string) {
  localStorage.setItem("current_theme", name);
}

function parseThemeCss(css: string): ThemeConfig {
  const nameMatch = css.match(/\/\*\s*Theme:\s*(.+?)\s*\*\//);
  const name = nameMatch ? nameMatch[1] : "Custom Theme";

  const variables: Record<string, string> = {};
  const varRegex = /--([\w-]+)\s*:\s*([^;]+);/g;
  let match;
  while ((match = varRegex.exec(css)) !== null) {
    variables[`--${match[1]}`] = match[2].trim();
  }

  return { name, variables };
}

function applyTheme(theme: ThemeConfig | null) {
  // Remove existing theme style element if any
  const existingStyle = document.getElementById("custom-theme-style");
  if (existingStyle) {
    existingStyle.remove();
  }

  if (!theme || Object.keys(theme.variables).length === 0) {
    return;
  }

  // Create new style element with theme variables
  const style = document.createElement("style");
  style.id = "custom-theme-style";
  style.textContent = `:root {\n${Object.entries(theme.variables)
    .map(([key, value]) => `  ${key}: ${value};`)
    .join("\n")}\n}`;
  document.head.appendChild(style);
}

async function getThemesDir(): Promise<string> {
  const appDataDir = await invoke<string>("get_app_data_dir");
  return `${appDataDir}/themes`;
}

async function loadThemeFromFile(themesDir: string, filename: string): Promise<ThemeConfig | null> {
  try {
    const content = await invoke<string>("read_file", { path: `${themesDir}/${filename}` });
    return parseThemeCss(content);
  } catch {
    return null;
  }
}

async function listThemeFiles(): Promise<string[]> {
  try {
    const themesDir = await getThemesDir();
    const files = await invoke<string[]>("list_files_in_dir", { path: themesDir });
    return files.filter(f => f.endsWith(".css"));
  } catch {
    return [];
  }
}

async function deleteThemeFile(filename: string): Promise<void> {
  const themesDir = await getThemesDir();
  await invoke("delete_file", { path: `${themesDir}/${filename}` });
}

const ChevronIcon = ({ open }: { open: boolean }) => (
  <svg
    width="12"
    height="12"
    viewBox="0 0 12 12"
    fill="none"
    className={`chevron ${open ? "open" : ""}`}
  >
    <path
      d="M4.5 2.5L8 6L4.5 9.5"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

const Spinner = () => (
  <svg className="spinner icon-sm" viewBox="0 0 12 12">
    <circle
      cx="6"
      cy="6"
      r="4.5"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeDasharray="20"
      strokeDashoffset="10"
    />
  </svg>
);

// Helper to get CSS variable value
function getCssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

const PriorityIcon = ({ priority }: { priority: string }) => {
  const colors: Record<string, string> = {
    Highest: "var(--priority-highest)",
    High: "var(--priority-high)",
    Medium: "var(--priority-medium)",
    Low: "var(--priority-low)",
    Lowest: "var(--priority-lowest)",
  };
  const color = colors[priority] || "var(--priority-default)";

  return (
    <svg className="icon-xs" viewBox="0 0 10 10" fill="none" style={{ flexShrink: 0 }}>
      {priority === "Highest" && (
        <>
          <path d="M5 0L8 3H2L5 0Z" fill={color} />
          <path d="M5 4L8 7H2L5 4Z" fill={color} />
        </>
      )}
      {priority === "High" && (
        <path d="M5 1L9 6H1L5 1Z" fill={color} />
      )}
      {priority === "Medium" && (
        <circle cx="5" cy="5" r="3" fill={color} />
      )}
      {priority === "Low" && (
        <path d="M5 9L1 4H9L5 9Z" fill={color} />
      )}
      {priority === "Lowest" && (
        <>
          <path d="M5 6L8 3H2L5 6Z" fill={color} />
          <path d="M5 10L8 7H2L5 10Z" fill={color} />
        </>
      )}
      {!["Highest", "High", "Medium", "Low", "Lowest"].includes(priority) && (
        <circle cx="5" cy="5" r="2" fill={color} />
      )}
    </svg>
  );
};

const HideIcon = () => (
  <svg className="icon-xs" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" />
    <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" />
    <line x1="1" y1="1" x2="23" y2="23" />
  </svg>
);

const SettingsIcon = () => (
  <svg className="icon-xs" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
    <circle cx="12" cy="12" r="3" />
  </svg>
);

const PlusIcon = () => (
  <svg className="icon-xs" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <line x1="12" y1="5" x2="12" y2="19" />
    <line x1="5" y1="12" x2="19" y2="12" />
  </svg>
);

const WorktreeIcon = () => (
  <svg className="icon-xs worktree-indicator" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M6 3v12" />
    <circle cx="18" cy="6" r="3" />
    <circle cx="6" cy="18" r="3" />
    <path d="M18 9a9 9 0 01-9 9" />
  </svg>
);

const PinIcon = () => (
  <svg className="icon-xs" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <line x1="12" y1="17" x2="12" y2="22" />
    <path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z" />
  </svg>
);

const UnpinIcon = () => (
  <svg className="icon-xs" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <line x1="12" y1="17" x2="12" y2="22" />
    <path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z" />
    <line x1="2" y1="2" x2="22" y2="22" />
  </svg>
);

const GearIcon = () => (
  <svg className="icon-md" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
    <circle cx="12" cy="12" r="3" />
  </svg>
);

function getAuthHeader() {
  const conn = getActiveConnection();
  if (!conn) return "";
  return "Basic " + btoa(`${conn.username}:${conn.token}`);
}

function getBaseUrl() {
  const conn = getActiveConnection();
  return conn?.baseUrl || "";
}

function getStatusColor(status: string, statusCategory: string): string {
  const statusLower = status.toLowerCase();

  // Specific status names (Korean & English)
  if (statusLower.includes("리뷰") || statusLower.includes("review")) return "var(--status-review)";
  if (statusLower.includes("배포") || statusLower.includes("deploy") || statusLower.includes("release")) return "var(--status-done)";
  if (statusLower.includes("block") || statusLower.includes("차단")) return "var(--status-blocked)";
  if (statusLower.includes("done") || statusLower.includes("완료") || statusLower.includes("closed")) return "var(--status-done)";

  // Fall back to category
  switch (statusCategory) {
    case "new": return "var(--status-new)";
    case "done": return "var(--status-done)";
    case "indeterminate": return "var(--text)";
    default: return "var(--text)";
  }
}

function getStatusBgColor(status: string, statusCategory: string): string {
  const statusLower = status.toLowerCase();

  // Specific status names (Korean & English)
  if (statusLower.includes("리뷰") || statusLower.includes("review")) return "var(--status-review-bg)";
  if (statusLower.includes("배포") || statusLower.includes("deploy") || statusLower.includes("release")) return "var(--status-done-bg)";
  if (statusLower.includes("block") || statusLower.includes("차단")) return "var(--status-blocked-bg)";
  if (statusLower.includes("done") || statusLower.includes("완료") || statusLower.includes("closed")) return "var(--status-done-bg)";

  // Fall back to category
  switch (statusCategory) {
    case "new": return "var(--status-new-bg)";
    case "done": return "var(--status-done-bg)";
    case "indeterminate": return "var(--status-inprogress-bg)";
    default: return "var(--status-inprogress-bg)";
  }
}

async function fetchProjects(): Promise<Project[]> {
  const res = await fetch(`${getBaseUrl()}/rest/api/3/project/search?maxResults=100`, {
    headers: { Authorization: getAuthHeader(), Accept: "application/json" },
  });
  if (!res.ok) throw new Error("Failed to fetch projects");
  const data = await res.json();
  return (data.values || []).map((p: any) => ({
    id: p.id,
    key: p.key,
    name: p.name,
  }));
}

async function fetchIssues(projectKey: string): Promise<Issue[]> {
  const filter = getProjectFilter(projectKey);
  const conditions: string[] = [`project=${projectKey}`];

  if (filter.assigneeMe) {
    conditions.push("assignee = currentUser()");
  }
  if (filter.statuses.length > 0) {
    conditions.push(`status IN (${filter.statuses.map(s => `"${s}"`).join(", ")})`);
  }
  if (filter.issueTypes.length > 0) {
    conditions.push(`issuetype IN (${filter.issueTypes.map(t => `"${t}"`).join(", ")})`);
  }
  if (filter.priorityMin) {
    conditions.push(`priority >= "${filter.priorityMin}"`);
  }
  if (filter.jqlExtra) {
    conditions.push(filter.jqlExtra);
  }

  const jql = conditions.join(" AND ") + ` ORDER BY ${filter.sortBy} ${filter.sortOrder}`;
  const url = `${getBaseUrl()}/rest/api/3/search/jql?jql=${encodeURIComponent(jql)}&fields=summary,priority,issuetype,status,duedate&maxResults=${filter.maxResults}`;
  const res = await fetch(url, {
    headers: {
      Authorization: getAuthHeader(),
      Accept: "application/json",
    },
  });
  if (!res.ok) throw new Error("Failed to fetch issues");
  const data = await res.json();
  return (data.issues || []).map((i: any) => ({
    id: i.id,
    key: i.key,
    summary: i.fields.summary,
    priority: i.fields.priority?.name || "",
    issueType: i.fields.issuetype?.name || "",
    status: i.fields.status?.name || "",
    statusCategory: i.fields.status?.statusCategory?.key || "",
    dueDate: i.fields.duedate || null,
  }));
}

async function fetchIssueDetail(issueKey: string): Promise<IssueDetail> {
  const url = `${getBaseUrl()}/rest/api/3/issue/${issueKey}?fields=summary,description,status,priority,assignee,reporter,created,updated,labels,components,issuetype,comment,project,parent,timetracking,worklog,duedate`;
  const res = await fetch(url, {
    headers: {
      Authorization: getAuthHeader(),
      Accept: "application/json",
    },
  });
  if (!res.ok) throw new Error("Failed to fetch issue detail");
  const data = await res.json();
  const comments = (data.fields.comment?.comments || []).map((c: any) => ({
    id: c.id,
    author: c.author?.displayName || "Unknown",
    authorId: c.author?.accountId || "",
    body: parseDescription(c.body),
    created: c.created || "",
  }));

  const tt = data.fields.timetracking;
  const timeTracking: TimeTracking | null = tt ? {
    originalEstimate: tt.originalEstimate || null,
    remainingEstimate: tt.remainingEstimate || null,
    timeSpent: tt.timeSpent || null,
    originalEstimateSeconds: tt.originalEstimateSeconds || null,
    remainingEstimateSeconds: tt.remainingEstimateSeconds || null,
    timeSpentSeconds: tt.timeSpentSeconds || null,
  } : null;

  const worklogs: Worklog[] = (data.fields.worklog?.worklogs || []).map((w: any) => ({
    id: w.id,
    author: w.author?.displayName || "Unknown",
    authorId: w.author?.accountId || "",
    timeSpent: w.timeSpent || "",
    timeSpentSeconds: w.timeSpentSeconds || 0,
    comment: parseDescription(w.comment),
    started: w.started || "",
    created: w.created || "",
  }));

  return {
    id: data.id,
    key: data.key,
    summary: data.fields.summary || "",
    description: parseDescription(data.fields.description),
    descriptionRaw: data.fields.description,
    status: data.fields.status?.name || "",
    statusCategory: data.fields.status?.statusCategory?.key || "",
    priority: data.fields.priority?.name || "",
    priorityId: data.fields.priority?.id || "",
    assignee: data.fields.assignee?.displayName || "Unassigned",
    assigneeId: data.fields.assignee?.accountId || null,
    reporter: data.fields.reporter?.displayName || "",
    reporterId: data.fields.reporter?.accountId || null,
    created: data.fields.created || "",
    updated: data.fields.updated || "",
    labels: data.fields.labels || [],
    components: (data.fields.components || []).map((c: any) => c.name),
    issueType: data.fields.issuetype?.name || "",
    projectKey: data.fields.project?.key || issueKey.split("-")[0],
    comments,
    parentKey: data.fields.parent?.key || null,
    parentSummary: data.fields.parent?.fields?.summary || null,
    timeTracking,
    worklogs,
    dueDate: data.fields.duedate || null,
  };
}

// Update APIs
async function updateIssueField(issueKey: string, field: string, value: any): Promise<void> {
  const body: any = { fields: { [field]: value } };
  const res = await fetch(`${getBaseUrl()}/rest/api/3/issue/${issueKey}`, {
    method: "PUT",
    headers: {
      Authorization: getAuthHeader(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error("Failed to update issue");
}

async function fetchTransitions(issueKey: string): Promise<{ id: string; name: string }[]> {
  const res = await fetch(`${getBaseUrl()}/rest/api/3/issue/${issueKey}/transitions`, {
    headers: { Authorization: getAuthHeader(), Accept: "application/json" },
  });
  if (!res.ok) return [];
  const data = await res.json();
  return (data.transitions || []).map((t: any) => ({ id: t.id, name: t.name }));
}

async function transitionIssue(issueKey: string, transitionId: string): Promise<void> {
  const res = await fetch(`${getBaseUrl()}/rest/api/3/issue/${issueKey}/transitions`, {
    method: "POST",
    headers: {
      Authorization: getAuthHeader(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ transition: { id: transitionId } }),
  });
  if (!res.ok) throw new Error("Failed to transition issue");
}

async function fetchAssignableUsers(projectKey: string): Promise<{ accountId: string; displayName: string }[]> {
  const res = await fetch(`${getBaseUrl()}/rest/api/3/user/assignable/search?project=${projectKey}&maxResults=50`, {
    headers: { Authorization: getAuthHeader(), Accept: "application/json" },
  });
  if (!res.ok) return [];
  const data = await res.json();
  return data.map((u: any) => ({ accountId: u.accountId, displayName: u.displayName }));
}

async function fetchCurrentUser(): Promise<{ accountId: string; displayName: string } | null> {
  const res = await fetch(`${getBaseUrl()}/rest/api/3/myself`, {
    headers: { Authorization: getAuthHeader(), Accept: "application/json" },
  });
  if (!res.ok) return null;
  const data = await res.json();
  return { accountId: data.accountId, displayName: data.displayName };
}

async function fetchPriorities(): Promise<{ id: string; name: string }[]> {
  const res = await fetch(`${getBaseUrl()}/rest/api/3/priority`, {
    headers: { Authorization: getAuthHeader(), Accept: "application/json" },
  });
  if (!res.ok) return [];
  const data = await res.json();
  return data.map((p: any) => ({ id: p.id, name: p.name }));
}

async function fetchProjectComponents(projectKey: string): Promise<{ id: string; name: string }[]> {
  const res = await fetch(`${getBaseUrl()}/rest/api/3/project/${projectKey}/components`, {
    headers: { Authorization: getAuthHeader(), Accept: "application/json" },
  });
  if (!res.ok) return [];
  const data = await res.json();
  return data.map((c: any) => ({ id: c.id, name: c.name }));
}

async function fetchLabels(): Promise<string[]> {
  const res = await fetch(`${getBaseUrl()}/rest/api/3/label`, {
    headers: { Authorization: getAuthHeader(), Accept: "application/json" },
  });
  if (!res.ok) return [];
  const data = await res.json();
  return data.values || [];
}

// Worklog API functions
function toJiraDatetime(date: Date): string {
  // Jira expects: 2024-01-01T12:00:00.000+0900
  const pad = (n: number, len = 2) => String(n).padStart(len, "0");
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  const absOffset = Math.abs(offset);
  const offsetHours = pad(Math.floor(absOffset / 60));
  const offsetMinutes = pad(absOffset % 60);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}${sign}${offsetHours}${offsetMinutes}`;
}

async function addWorklog(issueKey: string, timeSpent: string, comment?: string, started?: string): Promise<void> {
  const body: any = {
    timeSpent,
    started: started || toJiraDatetime(new Date()),
  };
  if (comment) {
    body.comment = {
      type: "doc",
      version: 1,
      content: [{ type: "paragraph", content: [{ type: "text", text: comment }] }],
    };
  }
  // adjustEstimate=auto: remaining에서 logged만큼 자동 차감
  const res = await fetch(`${getBaseUrl()}/rest/api/3/issue/${issueKey}/worklog?adjustEstimate=auto`, {
    method: "POST",
    headers: {
      Authorization: getAuthHeader(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errData = await res.json().catch(() => ({}));
    throw new Error(errData.errorMessages?.[0] || "Failed to add worklog");
  }
}

async function deleteWorklog(issueKey: string, worklogId: string): Promise<void> {
  const res = await fetch(`${getBaseUrl()}/rest/api/3/issue/${issueKey}/worklog/${worklogId}`, {
    method: "DELETE",
    headers: { Authorization: getAuthHeader() },
  });
  if (!res.ok) throw new Error("Failed to delete worklog");
}

async function updateWorklog(issueKey: string, worklogId: string, timeSpent: string, comment?: string): Promise<void> {
  const body: any = { timeSpent };
  if (comment !== undefined) {
    body.comment = comment ? {
      type: "doc",
      version: 1,
      content: [{ type: "paragraph", content: [{ type: "text", text: comment }] }],
    } : null;
  }
  const res = await fetch(`${getBaseUrl()}/rest/api/3/issue/${issueKey}/worklog/${worklogId}`, {
    method: "PUT",
    headers: {
      Authorization: getAuthHeader(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error("Failed to update worklog");
}

async function updateTimeEstimate(issueKey: string, originalEstimate: string | null, remainingEstimate: string | null): Promise<void> {
  const timetracking: any = {};
  // null = don't update, empty string = clear, string = set value
  if (originalEstimate !== null) timetracking.originalEstimate = originalEstimate || null;
  if (remainingEstimate !== null) timetracking.remainingEstimate = remainingEstimate || null;

  if (Object.keys(timetracking).length === 0) return; // nothing to update

  const res = await fetch(`${getBaseUrl()}/rest/api/3/issue/${issueKey}`, {
    method: "PUT",
    headers: {
      Authorization: getAuthHeader(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ fields: { timetracking } }),
  });
  if (!res.ok) {
    const errData = await res.json().catch(() => ({}));
    throw new Error(errData.errorMessages?.[0] || errData.errors?.timetracking || "Failed to update time estimate");
  }
}

function textToAdf(text: string) {
  return {
    type: "doc",
    version: 1,
    content: text.split("\n").map((line: string) => ({
      type: "paragraph",
      content: line ? [{ type: "text", text: line }] : [],
    })),
  };
}

async function addComment(issueKey: string, body: string): Promise<void> {
  const res = await fetch(`${getBaseUrl()}/rest/api/3/issue/${issueKey}/comment`, {
    method: "POST",
    headers: {
      Authorization: getAuthHeader(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ body: textToAdf(body) }),
  });
  if (!res.ok) throw new Error("Failed to add comment");
}

async function updateComment(issueKey: string, commentId: string, body: string): Promise<void> {
  const res = await fetch(`${getBaseUrl()}/rest/api/3/issue/${issueKey}/comment/${commentId}`, {
    method: "PUT",
    headers: {
      Authorization: getAuthHeader(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ body: textToAdf(body) }),
  });
  if (!res.ok) throw new Error("Failed to update comment");
}

async function deleteComment(issueKey: string, commentId: string): Promise<void> {
  const res = await fetch(`${getBaseUrl()}/rest/api/3/issue/${issueKey}/comment/${commentId}`, {
    method: "DELETE",
    headers: { Authorization: getAuthHeader() },
  });
  if (!res.ok) throw new Error("Failed to delete comment");
}

type CreateIssueParams = {
  projectKey: string;
  summary: string;
  issueType: string;
  description?: string;
  priorityId?: string;
  assigneeId?: string;
  parentKey?: string;
  labels?: string[];
  componentIds?: string[];
};

async function createIssue(params: CreateIssueParams): Promise<string> {
  const fields: any = {
    project: { key: params.projectKey },
    summary: params.summary,
    issuetype: { name: params.issueType },
  };
  if (params.description) {
    fields.description = textToAdf(params.description);
  }
  if (params.priorityId) {
    fields.priority = { id: params.priorityId };
  }
  if (params.assigneeId) {
    fields.assignee = { accountId: params.assigneeId };
  }
  if (params.parentKey) {
    fields.parent = { key: params.parentKey };
  }
  if (params.labels && params.labels.length > 0) {
    fields.labels = params.labels;
  }
  if (params.componentIds && params.componentIds.length > 0) {
    fields.components = params.componentIds.map(id => ({ id }));
  }

  const res = await fetch(`${getBaseUrl()}/rest/api/3/issue`, {
    method: "POST",
    headers: {
      Authorization: getAuthHeader(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ fields }),
  });
  if (!res.ok) {
    const errData = await res.json().catch(() => ({}));
    throw new Error(errData.errors ? Object.values(errData.errors).join(", ") : "Failed to create issue");
  }
  const data = await res.json();
  return data.key;
}

function parseDescription(desc: any): string {
  if (!desc) return "";
  if (typeof desc === "string") return desc;

  // Atlassian Document Format (ADF) -> Markdown
  const convertNode = (node: any, listDepth = 0): string => {
    if (!node) return "";

    switch (node.type) {
      case "doc":
        return (node.content || []).map((n: any) => convertNode(n, listDepth)).join("\n\n");

      case "paragraph":
        return (node.content || []).map((n: any) => convertNode(n, listDepth)).join("");

      case "text": {
        let text = node.text || "";
        const marks = node.marks || [];
        marks.forEach((mark: any) => {
          switch (mark.type) {
            case "strong": text = `**${text}**`; break;
            case "em": text = `*${text}*`; break;
            case "code": text = `\`${text}\``; break;
            case "strike": text = `~~${text}~~`; break;
            case "underline": text = `<u>${text}</u>`; break;
            case "link": text = `[${text}](${mark.attrs?.href || ""})`; break;
            case "textColor": break; // ignore colors
            case "subsup": break;
          }
        });
        return text;
      }

      case "heading": {
        const level = node.attrs?.level || 1;
        const text = (node.content || []).map((n: any) => convertNode(n, listDepth)).join("");
        return "#".repeat(level) + " " + text;
      }

      case "bulletList":
        return (node.content || []).map((item: any) => convertNode(item, listDepth)).join("\n");

      case "orderedList":
        return (node.content || []).map((item: any, i: number) => {
          const content = convertNode(item, listDepth);
          return content.replace(/^- /, `${i + 1}. `);
        }).join("\n");

      case "listItem": {
        const indent = "  ".repeat(listDepth);
        const content = (node.content || []).map((n: any) => convertNode(n, listDepth + 1)).join("\n");
        return `${indent}- ${content}`;
      }

      case "codeBlock": {
        const lang = node.attrs?.language || "";
        const code = (node.content || []).map((n: any) => convertNode(n, listDepth)).join("");
        return "```" + lang + "\n" + code + "\n```";
      }

      case "blockquote": {
        const content = (node.content || []).map((n: any) => convertNode(n, listDepth)).join("\n");
        return content.split("\n").map((line: string) => "> " + line).join("\n");
      }

      case "rule":
        return "---";

      case "hardBreak":
        return "  \n";

      case "mention":
        return `**@${node.attrs?.text || node.attrs?.id || "user"}**`;

      case "emoji":
        return node.attrs?.text || node.attrs?.shortName || "";

      case "inlineCard":
        return node.attrs?.url ? `[Link](${node.attrs.url})` : "";

      case "table":
        return convertTable(node);

      case "panel": {
        const panelContent = (node.content || []).map((n: any) => convertNode(n, listDepth)).join("\n");
        return `> ${panelContent}`;
      }

      case "expand": {
        const title = node.attrs?.title || "Details";
        const expandContent = (node.content || []).map((n: any) => convertNode(n, listDepth)).join("\n");
        return `**${title}**\n${expandContent}`;
      }

      case "status":
        return `\`${node.attrs?.text || "status"}\``;

      case "date":
        return node.attrs?.timestamp ? new Date(parseInt(node.attrs.timestamp)).toLocaleDateString() : "";

      case "placeholder":
        return "";

      case "mediaGroup":
      case "mediaSingle":
      case "media":
        return "*[media]*";

      default:
        if (node.content) return (node.content || []).map((n: any) => convertNode(n, listDepth)).join("");
        return "";
    }
  };

  const convertTable = (tableNode: any): string => {
    const rows = tableNode.content || [];
    if (rows.length === 0) return "";

    const result: string[] = [];
    rows.forEach((row: any, rowIndex: number) => {
      const cells = (row.content || []).map((cell: any) => {
        const content = (cell.content || []).map((n: any) => convertNode(n)).join(" ");
        return content.replace(/\|/g, "\\|").trim() || " ";
      });
      result.push("| " + cells.join(" | ") + " |");

      if (rowIndex === 0) {
        result.push("| " + cells.map(() => "---").join(" | ") + " |");
      }
    });
    return result.join("\n");
  };

  return convertNode(desc);
}

function getHiddenProjects(): string[] {
  const saved = localStorage.getItem(`${getStoragePrefix()}hidden_projects`);
  return saved ? JSON.parse(saved) : [];
}

function setHiddenProjects(keys: string[]) {
  localStorage.setItem(`${getStoragePrefix()}hidden_projects`, JSON.stringify(keys));
}

function ProjectTree({
  onSettingsClick,
  onRefresh,
  hiddenProjects,
  onHideProject,
  onIssueClick,
  selectedIssue,
  onCreateClick,
  pinnedIssues,
  onPinToggle,
  onIssuesChange,
}: {
  onSettingsClick: (projectKey: string) => void;
  onRefresh: number;
  hiddenProjects: string[];
  onHideProject: (projectKey: string) => void;
  onIssueClick: (issueKey: string) => void;
  selectedIssue: string | null;
  onCreateClick: (projectKey: string) => void;
  pinnedIssues: string[];
  onPinToggle: (issueKey: string) => void;
  onIssuesChange: (issueKeys: Set<string>) => void;
}) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [openProjects, setOpenProjectsState] = useState<Record<string, boolean>>(getOpenProjects);
  const [projectIssues, setProjectIssues] = useState<Record<string, Issue[]>>({});
  const [loadingIssues, setLoadingIssues] = useState<Record<string, boolean>>({});

  const setOpenProjects = (updater: Record<string, boolean> | ((prev: Record<string, boolean>) => Record<string, boolean>)) => {
    setOpenProjectsState(prev => {
      const next = typeof updater === 'function' ? updater(prev) : updater;
      saveOpenProjects(next);
      return next;
    });
  };

  useEffect(() => {
    fetchProjects()
      .then(setProjects)
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  // Load issues for previously open projects on mount
  useEffect(() => {
    if (projects.length > 0) {
      Object.keys(openProjects).forEach((key) => {
        if (openProjects[key] && projects.some(p => p.key === key)) {
          loadIssues(key);
        }
      });
    }
  }, [projects.length > 0]); // Only run once when projects load

  const loadIssues = async (projectKey: string, silent = false) => {
    if (!silent) setLoadingIssues((prev) => ({ ...prev, [projectKey]: true }));
    try {
      const issues = await fetchIssues(projectKey);
      setProjectIssues((prev) => ({ ...prev, [projectKey]: issues }));
    } catch (e) {
      console.error(e);
    } finally {
      if (!silent) setLoadingIssues((prev) => ({ ...prev, [projectKey]: false }));
    }
  };

  const toggleProject = async (projectKey: string) => {
    const isOpen = openProjects[projectKey];
    setOpenProjects((prev) => ({ ...prev, [projectKey]: !isOpen }));
    if (!isOpen) {
      setProjectIssues((prev) => ({ ...prev, [projectKey]: [] }));
      loadIssues(projectKey);
    }
  };


  const visibleProjects = projects.filter(p => !hiddenProjects.includes(p.key));

  // Notify parent of visible issue keys
  useEffect(() => {
    const allIssueKeys = new Set<string>();
    Object.values(projectIssues).forEach(issues => {
      issues.forEach(issue => allIssueKeys.add(issue.key));
    });
    onIssuesChange(allIssueKeys);
  }, [projectIssues]);

  useEffect(() => {
    if (onRefresh > 0) {
      Object.keys(openProjects).forEach((key) => {
        if (openProjects[key]) loadIssues(key);
      });
    }
  }, [onRefresh]);

  // Periodic refresh every 2 minutes (silent - no loading indicator)
  useEffect(() => {
    const interval = setInterval(() => {
      // Refresh project list
      fetchProjects().then(setProjects).catch(console.error);
      // Refresh issues for open projects
      Object.keys(openProjects).forEach((key) => {
        if (openProjects[key]) loadIssues(key, true);
      });
    }, 120000);
    return () => clearInterval(interval);
  }, [openProjects]);

  if (loading) {
    return (
      <div className="tree-loading">
        <Spinner /> Loading...
      </div>
    );
  }

  return (
    <div className="project-tree">
      {visibleProjects.map((project) => (
        <div key={project.id}>
          <div className="tree-item folder">
            <div className="tree-item-left" onClick={() => toggleProject(project.key)}>
              {loadingIssues[project.key] ? (
                <Spinner />
              ) : (
                <ChevronIcon open={openProjects[project.key]} />
              )}
              <span className="node-name">{project.key}</span>
              {projectIssues[project.key] && projectIssues[project.key].length > 0 && (
                <span className="issue-count">({projectIssues[project.key].length})</span>
              )}
            </div>
            <div className="tree-item-actions">
              <button className="icon-btn" onClick={(e) => { e.stopPropagation(); onCreateClick(project.key); }} title="Create Issue">
                <PlusIcon />
              </button>
              <button className="icon-btn" onClick={(e) => { e.stopPropagation(); onSettingsClick(project.key); }} title="Settings">
                <SettingsIcon />
              </button>
              <button className="icon-btn" onClick={(e) => { e.stopPropagation(); onHideProject(project.key); }} title="Hide">
                <HideIcon />
              </button>
            </div>
          </div>
          {openProjects[project.key] && projectIssues[project.key] && (
            <div>
              {[...projectIssues[project.key]].sort((a, b) => {
                const aPinned = pinnedIssues.includes(a.key);
                const bPinned = pinnedIssues.includes(b.key);
                if (aPinned && !bPinned) return -1;
                if (!aPinned && bPinned) return 1;
                return 0;
              }).map((issue) => {
                const isResolved = issue.statusCategory === "done";
                let dueDaysLeft: number | null = null;
                if (issue.dueDate && !isResolved) {
                  const [y, m, d] = issue.dueDate.split("-").map(Number);
                  const due = new Date(y, m - 1, d);
                  const today = new Date();
                  today.setHours(0, 0, 0, 0);
                  dueDaysLeft = Math.ceil((due.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
                }
                const isOverdue = dueDaysLeft !== null && dueDaysLeft < 0;
                const isDueToday = dueDaysLeft === 0;
                return (
                <div
                  key={issue.id}
                  className={`tree-item file issue-item ${selectedIssue === issue.key ? "selected" : ""}`}
                  onClick={() => onIssueClick(issue.key)}
                  data-status-category={issue.statusCategory}
                  data-status={issue.status}
                  style={{ color: getStatusColor(issue.status, issue.statusCategory) }}
                >
                  <div className="issue-item-left">
                    <span className="worktree-slot">{getIssueWorktree(project.key, issue.key) && <WorktreeIcon />}</span>
                    <PriorityIcon priority={issue.priority} />
                    <span className={`issue-key ${isOverdue ? "overdue" : isDueToday ? "due-today" : ""}`}>{issue.key}</span>
                    <span className="node-name">{issue.summary}</span>
                  </div>
                  <button
                    className={`icon-btn issue-pin-btn ${pinnedIssues.includes(issue.key) ? "pinned" : ""}`}
                    onClick={(e) => { e.stopPropagation(); onPinToggle(issue.key); }}
                    title={pinnedIssues.includes(issue.key) ? "Unpin" : "Pin"}
                  >
                    {pinnedIssues.includes(issue.key) ? <UnpinIcon /> : <PinIcon />}
                  </button>
                </div>
              );})}
              {projectIssues[project.key].length === 0 && (
                <div className="tree-item file empty">No issues</div>
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function Setup({ onComplete }: { onComplete: () => void }) {
  const [name, setName] = useState("");
  const [username, setUsername] = useState("");
  const [token, setToken] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!username || !token || !baseUrl) return;

    setIsLoading(true);
    setError(null);

    try {
      // Normalize base URL
      const normalizedUrl = baseUrl.replace(/\/$/, "");

      // Test API connection
      const response = await fetch(`${normalizedUrl}/rest/api/3/myself`, {
        headers: {
          "Authorization": `Basic ${btoa(`${username}:${token}`)}`,
          "Content-Type": "application/json",
        },
      });

      if (!response.ok) {
        if (response.status === 401) {
          throw new Error("Invalid credentials. Please check your username and API token.");
        } else if (response.status === 403) {
          throw new Error("Access denied. Please check your permissions.");
        } else if (response.status === 404) {
          throw new Error("Invalid Base URL. Please check your Jira domain.");
        } else {
          throw new Error(`Connection failed (${response.status}). Please check your settings.`);
        }
      }

      // Success - save as new connection
      const conn: JiraConnection = {
        id: generateConnectionId(),
        name,
        username,
        token,
        baseUrl: normalizedUrl,
      };
      const connections = getJiraConnections();
      connections.push(conn);
      saveJiraConnections(connections);
      setActiveConnectionId(conn.id);
      onComplete();
    } catch (err: any) {
      if (err.name === "TypeError" && err.message.includes("fetch")) {
        setError("Cannot connect to server. Please check your Base URL.");
      } else {
        setError(err.message || "Connection failed. Please check your settings.");
      }
    } finally {
      setIsLoading(false);
    }
  };

  const isValid = name && username && token && baseUrl && !isLoading;

  return (
    <div className="setup">
      <div className="setup-container">
        <h1 className="setup-title">Setup</h1>
        <p className="setup-desc">Enter your Jira API credentials</p>
        <form onSubmit={handleSubmit}>
          <div className="input-group">
            <label>Connection Name</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="My Company Jira"
              disabled={isLoading}
            />
          </div>
          <div className="input-group">
            <label>Username</label>
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="your@email.com"
              disabled={isLoading}
            />
          </div>
          <div className="input-group">
            <label>API Token</label>
            <input
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="••••••••"
              disabled={isLoading}
            />
          </div>
          <div className="input-group">
            <label>Base URL</label>
            <input
              type="text"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="https://your-domain.atlassian.net"
              disabled={isLoading}
            />
          </div>
          {error && <div className="setup-error">{error}</div>}
          <button type="submit" className="submit-btn" disabled={!isValid}>
            {isLoading ? "Connecting..." : "Continue"}
          </button>
        </form>
      </div>
    </div>
  );
}

const PRIORITY_OPTIONS = ["Highest", "High", "Medium", "Low", "Lowest"];

type StatusInfo = { name: string; jqlName: string };

async function fetchProjectStatuses(projectKey: string): Promise<StatusInfo[]> {
  const res = await fetch(`${getBaseUrl()}/rest/api/3/project/${projectKey}/statuses`, {
    headers: {
      Authorization: getAuthHeader(),
      Accept: "application/json",
    },
  });
  if (!res.ok) return [];
  const data = await res.json();
  const statusMap = new Map<string, StatusInfo>();
  data.forEach((issueType: any) => {
    issueType.statuses?.forEach((s: any) => {
      const jqlName = s.untranslatedName || s.name;
      statusMap.set(jqlName, { name: s.name, jqlName });
    });
  });
  return Array.from(statusMap.values());
}

async function fetchProjectIssueTypes(projectKey: string): Promise<string[]> {
  const res = await fetch(`${getBaseUrl()}/rest/api/3/project/${projectKey}`, {
    headers: {
      Authorization: getAuthHeader(),
      Accept: "application/json",
    },
  });
  if (!res.ok) return [];
  const data = await res.json();
  return data.issueTypes?.map((t: any) => t.name) || [];
}

async function fetchProjectIssueTypesWithId(projectKey: string): Promise<{ id: string; name: string }[]> {
  const res = await fetch(`${getBaseUrl()}/rest/api/3/project/${projectKey}`, {
    headers: {
      Authorization: getAuthHeader(),
      Accept: "application/json",
    },
  });
  if (!res.ok) return [];
  const data = await res.json();
  return data.issueTypes?.map((t: any) => ({ id: t.id, name: t.name })) || [];
}
const SORT_OPTIONS = [
  { value: "created", label: "Created" },
  { value: "updated", label: "Updated" },
  { value: "priority", label: "Priority" },
  { value: "summary", label: "Summary" },
  { value: "status", label: "Status" },
  { value: "assignee", label: "Assignee" },
];

function FilterSettings({ projectKey, onSave }: { projectKey: string; onSave: () => void }) {
  const [filter, setFilter] = useState<ProjectFilter>(() => getProjectFilter(projectKey));
  const [statuses, setStatuses] = useState<StatusInfo[]>([]);
  const [issueTypes, setIssueTypes] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    Promise.all([
      fetchProjectStatuses(projectKey),
      fetchProjectIssueTypes(projectKey),
    ]).then(([s, t]) => {
      setStatuses(s);
      setIssueTypes(t);
      const saved = getProjectFilter(projectKey);
      // 존재하지 않는 status/issueType 제거
      const validJqlNames = s.map(st => st.jqlName);
      saved.statuses = saved.statuses.filter(st => validJqlNames.includes(st));
      saved.issueTypes = saved.issueTypes.filter(it => t.includes(it));
      setFilter(saved);
      setLoading(false);
    });
  }, [projectKey]);

  const handleSave = () => {
    saveProjectFilter(projectKey, filter);
    onSave();
  };

  const toggleArrayItem = (arr: string[], item: string) => {
    return arr.includes(item) ? arr.filter(i => i !== item) : [...arr, item];
  };

  return (
    <div className="filter-settings">
      <div className="filter-header">{projectKey} Filter</div>
      <div className="filter-form">
        <div className="input-group checkbox-group">
          <label>
            <input
              type="checkbox"
              checked={filter.assigneeMe}
              onChange={(e) => setFilter({ ...filter, assigneeMe: e.target.checked })}
            />
            <span>Assigned to me only</span>
          </label>
        </div>

        <div className="input-group">
          <label>Status</label>
          {loading ? (
            <span className="loading-text">Loading...</span>
          ) : (
            <div className="chip-group">
              {statuses.map(status => (
                <button
                  key={status.jqlName}
                  className={`chip ${filter.statuses.includes(status.jqlName) ? "active" : ""}`}
                  onClick={() => setFilter({ ...filter, statuses: toggleArrayItem(filter.statuses, status.jqlName) })}
                >
                  {status.name}
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="input-group">
          <label>Issue Type</label>
          {loading ? (
            <span className="loading-text">Loading...</span>
          ) : (
            <div className="chip-group">
              {issueTypes.map(type => (
                <button
                  key={type}
                  className={`chip ${filter.issueTypes.includes(type) ? "active" : ""}`}
                  onClick={() => setFilter({ ...filter, issueTypes: toggleArrayItem(filter.issueTypes, type) })}
                >
                  {type}
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="filter-row">
          <div className="input-group">
            <label>Min Priority</label>
            <select
              value={filter.priorityMin}
              onChange={(e) => setFilter({ ...filter, priorityMin: e.target.value })}
            >
              <option value="">Any</option>
              {PRIORITY_OPTIONS.map(p => (
                <option key={p} value={p}>{p}</option>
              ))}
            </select>
          </div>

          <div className="input-group">
            <label>Max Results</label>
            <input
              type="number"
              value={filter.maxResults}
              onChange={(e) => setFilter({ ...filter, maxResults: parseInt(e.target.value) || 50 })}
              min={1}
              max={5000}
            />
          </div>
        </div>

        <div className="filter-row">
          <div className="input-group">
            <label>Sort By</label>
            <select
              value={filter.sortBy}
              onChange={(e) => setFilter({ ...filter, sortBy: e.target.value })}
            >
              {SORT_OPTIONS.map(opt => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
          </div>

          <div className="input-group">
            <label>Order</label>
            <select
              value={filter.sortOrder}
              onChange={(e) => setFilter({ ...filter, sortOrder: e.target.value as "ASC" | "DESC" })}
            >
              <option value="DESC">Descending</option>
              <option value="ASC">Ascending</option>
            </select>
          </div>
        </div>

        <div className="filter-section">
          <div className="filter-section-title">ADVANCED</div>
          <div className="input-group">
            <label>Additional JQL</label>
            <input
              type="text"
              value={filter.jqlExtra}
              onChange={(e) => setFilter({ ...filter, jqlExtra: e.target.value })}
              placeholder='e.g. labels = "urgent"'
            />
          </div>
        </div>

        <button className="save-btn" onClick={handleSave}>Save</button>
      </div>
    </div>
  );
}

function CreateIssueForm({
  projectKey,
  parentKey,
  onCreated,
  onCancel,
}: {
  projectKey: string;
  parentKey?: string;
  onCreated: (issueKey: string) => void;
  onCancel: () => void;
}) {
  const [summary, setSummary] = useState("");
  const [description, setDescription] = useState("");
  const [issueType, setIssueType] = useState("");
  const [priorityId, setPriorityId] = useState("");
  const [assigneeId, setAssigneeId] = useState("");
  const [issueTypes, setIssueTypes] = useState<string[]>([]);
  const [priorities, setPriorities] = useState<{ id: string; name: string }[]>([]);
  const [users, setUsers] = useState<{ accountId: string; displayName: string }[]>([]);
  const [availableLabels, setAvailableLabels] = useState<string[]>([]);
  const [selectedLabels, setSelectedLabels] = useState<string[]>([]);
  const [projectComponents, setProjectComponents] = useState<{ id: string; name: string }[]>([]);
  const [selectedComponents, setSelectedComponents] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    Promise.all([
      fetchProjectIssueTypes(projectKey),
      fetchPriorities(),
      fetchAssignableUsers(projectKey),
      fetchCurrentUser(),
      fetchLabels(),
      fetchProjectComponents(projectKey),
    ]).then(([types, prios, usrs, currentUser, labels, comps]) => {
      setIssueTypes(types);
      setPriorities(prios);
      setUsers(usrs);
      setAvailableLabels(labels);
      setProjectComponents(comps);
      if (types.length > 0) setIssueType(types[0]);
      if (currentUser) setAssigneeId(currentUser.accountId);
      setLoading(false);
    });
  }, [projectKey]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!summary.trim() || !issueType) return;

    setSubmitting(true);
    setError("");
    try {
      const newKey = await createIssue({
        projectKey,
        summary: summary.trim(),
        issueType,
        description: description.trim() || undefined,
        priorityId: priorityId || undefined,
        assigneeId: assigneeId || undefined,
        parentKey: parentKey || undefined,
        labels: selectedLabels.length > 0 ? selectedLabels : undefined,
        componentIds: selectedComponents.length > 0 ? selectedComponents : undefined,
      });
      onCreated(newKey);
    } catch (err: any) {
      setError(err.message || "Failed to create issue");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="create-issue-form">
      <div className="filter-header">
        {parentKey ? `Create Child Issue under ${parentKey}` : `Create Issue in ${projectKey}`}
      </div>
      <form className="filter-form" onSubmit={handleSubmit}>
        <div className="input-group">
          <label>Summary *</label>
          <input
            type="text"
            value={summary}
            onChange={(e) => setSummary(e.target.value)}
            placeholder="Issue summary"
            autoFocus
          />
        </div>

        <div className="input-group">
          <label>Issue Type *</label>
          {loading ? (
            <span className="loading-text">Loading...</span>
          ) : (
            <select value={issueType} onChange={(e) => setIssueType(e.target.value)}>
              {issueTypes.map((type) => (
                <option key={type} value={type}>{type}</option>
              ))}
            </select>
          )}
        </div>

        <div className="filter-row">
          <div className="input-group">
            <label>Priority</label>
            {loading ? (
              <span className="loading-text">Loading...</span>
            ) : (
              <select value={priorityId} onChange={(e) => setPriorityId(e.target.value)}>
                <option value="">Default</option>
                {priorities.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            )}
          </div>

          <div className="input-group">
            <label>Assignee</label>
            {loading ? (
              <span className="loading-text">Loading...</span>
            ) : (
              <select value={assigneeId} onChange={(e) => setAssigneeId(e.target.value)}>
                <option value="">Unassigned</option>
                {users.map((u) => (
                  <option key={u.accountId} value={u.accountId}>{u.displayName}</option>
                ))}
              </select>
            )}
          </div>
        </div>

        <div className="filter-row">
          <div className="input-group">
            <label>Labels</label>
            {loading ? (
              <span className="loading-text">Loading...</span>
            ) : (
              <div className="create-tags-list">
                {availableLabels.map((label) => (
                  <span
                    key={label}
                    className={`tag-selectable ${selectedLabels.includes(label) ? "selected" : ""}`}
                    onClick={() => {
                      if (selectedLabels.includes(label)) {
                        setSelectedLabels(selectedLabels.filter(l => l !== label));
                      } else {
                        setSelectedLabels([...selectedLabels, label]);
                      }
                    }}
                  >
                    {label}
                  </span>
                ))}
                {availableLabels.length === 0 && <span className="meta-empty">None</span>}
              </div>
            )}
          </div>

          <div className="input-group">
            <label>Components</label>
            {loading ? (
              <span className="loading-text">Loading...</span>
            ) : (
              <div className="create-tags-list">
                {projectComponents.map((comp) => (
                  <span
                    key={comp.id}
                    className={`tag-selectable ${selectedComponents.includes(comp.id) ? "selected" : ""}`}
                    onClick={() => {
                      if (selectedComponents.includes(comp.id)) {
                        setSelectedComponents(selectedComponents.filter(c => c !== comp.id));
                      } else {
                        setSelectedComponents([...selectedComponents, comp.id]);
                      }
                    }}
                  >
                    {comp.name}
                  </span>
                ))}
                {projectComponents.length === 0 && <span className="meta-empty">None</span>}
              </div>
            )}
          </div>
        </div>

        <div className="input-group">
          <label>Description</label>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Issue description (optional)"
            className="create-textarea"
          />
        </div>

        {error && <div className="create-error">{error}</div>}

        <div className="create-actions">
          <button type="submit" className="save-btn" disabled={submitting || !summary.trim() || !issueType}>
            {submitting ? "Creating..." : "Create"}
          </button>
          <button type="button" className="cancel-btn" onClick={onCancel}>Cancel</button>
        </div>
      </form>
    </div>
  );
}

function GlobalSettings({ onLogout, deletingWorktreeKeys, setDeletingWorktreeKeys, visibleIssueKeys }: { onLogout: () => void; deletingWorktreeKeys: Set<string>; setDeletingWorktreeKeys: React.Dispatch<React.SetStateAction<Set<string>>>; visibleIssueKeys: Set<string> }) {
  // Multi-connection state
  const [connections, setConnections] = useState<JiraConnection[]>(getJiraConnections);
  const [activeConnId, setActiveConnId] = useState<string | null>(getActiveConnectionId);
  const [editingConn, setEditingConn] = useState<JiraConnection | null>(null);
  const [addingConn, setAddingConn] = useState(false);
  const [newConn, setNewConn] = useState({ name: "", username: "", token: "", baseUrl: "" });
  const [connError, setConnError] = useState<string | null>(null);
  const [testingConn, setTestingConn] = useState(false);
  
  // Theme state
  const [themes, setThemes] = useState<ThemeListItem[]>([]);
  const [currentTheme, setCurrentTheme] = useState(getCurrentThemeName());
  const [loadingThemes, setLoadingThemes] = useState(true);
  const [editingTheme, setEditingTheme] = useState<string | null>(null);
  const [editorContent, setEditorContent] = useState("");

  // Shortcuts state
  const [shortcuts, setShortcuts] = useState<ShortcutConfig>(getShortcuts);
  const [recordingShortcut, setRecordingShortcut] = useState<ShortcutKey | null>(null);

  useEffect(() => {
    loadThemes();
  }, []);

  // Shortcut recording
  useEffect(() => {
    if (!recordingShortcut) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.code === "Escape") {
        setRecordingShortcut(null);
        return;
      }
      // Ignore modifier-only keys
      if (["MetaLeft", "MetaRight", "ControlLeft", "ControlRight", "AltLeft", "AltRight", "ShiftLeft", "ShiftRight"].includes(e.code)) return;

      // e.code에서 key 추출 (물리적 키 위치 기반)
      const codeToKey = (code: string): string => {
        if (code.startsWith("Key")) return code.slice(3).toLowerCase();
        if (code.startsWith("Digit")) return code.slice(5);
        const codeMap: Record<string, string> = {
          "Backslash": "\\", "BracketLeft": "[", "BracketRight": "]",
          "Equal": "=", "Minus": "-", "Quote": "'", "Semicolon": ";",
          "Comma": ",", "Period": ".", "Slash": "/", "Backquote": "`",
          "Space": " ", "Enter": "enter", "Tab": "tab", "Escape": "escape",
          "Backspace": "backspace", "Delete": "delete",
          "ArrowUp": "arrowup", "ArrowDown": "arrowdown",
          "ArrowLeft": "arrowleft", "ArrowRight": "arrowright",
        };
        return codeMap[code] || code.toLowerCase();
      };

      const newShortcut: Shortcut = {
        key: codeToKey(e.code),
        meta: e.metaKey,
        ctrl: e.ctrlKey,
        shift: e.shiftKey,
        alt: e.altKey,
      };
      const updated = { ...shortcuts, [recordingShortcut]: newShortcut };
      setShortcuts(updated);
      saveShortcuts(updated);
      setRecordingShortcut(null);
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [recordingShortcut, shortcuts]);

  const resetShortcuts = () => {
    setShortcuts(DEFAULT_SHORTCUTS);
    saveShortcuts(DEFAULT_SHORTCUTS);
  };

  // Worktree state
  type WorktreeEntry = {
    key: string;
    projectKey: string;
    issueKey: string;
    info: WorktreeInfo;
    isOrphaned?: boolean;
    repoPath?: string;
  };
  const [worktrees, setWorktrees] = useState<WorktreeEntry[]>([]);
  const [loadingWorktrees, setLoadingWorktrees] = useState(true);
  const [deletingWorktrees, setDeletingWorktrees] = useState(false);

  // Load worktrees from localStorage and scan git repos
  useEffect(() => {
    const loadAllWorktrees = async () => {
      setLoadingWorktrees(true);
      const entries: WorktreeEntry[] = [];
      const seenPaths = new Set<string>();

      // 1. Get localStorage worktrees
      const localWorktrees = getAllWorktrees();
      for (const wt of localWorktrees) {
        entries.push({ ...wt, isOrphaned: false });
        seenPaths.add(wt.info.path);
      }

      // 2. Get all unique repo paths from worktree info (for current connection)
      const repoPaths = new Set<string>();
      for (const wt of localWorktrees) {
        if (wt.info.repoPath) {
          repoPaths.add(wt.info.repoPath);
        }
      }

      // 3. For each repo, scan git worktrees
      for (const repoPath of repoPaths) {
        try {
          const output = await invoke<string>("run_git_command", {
            cwd: repoPath,
            args: ["worktree", "list", "--porcelain"],
          });

          // Parse porcelain output - split by double newline to get each worktree block
          const blocks = output.trim().split("\n\n");

          for (const block of blocks) {
            const lines = block.split("\n");
            let wtPath = "";
            let wtBranch = "";

            for (const line of lines) {
              if (line.startsWith("worktree ")) {
                wtPath = line.substring(9);
              } else if (line.startsWith("branch refs/heads/")) {
                wtBranch = line.substring(18);
              } else if (line.startsWith("HEAD ")) {
                // Detached HEAD - use commit hash as branch name
                wtBranch = `detached:${line.substring(5, 12)}`;
              }
            }

            // Skip main worktree (same as repo path) and already seen paths
            if (wtPath && wtPath !== repoPath && !seenPaths.has(wtPath)) {
              entries.push({
                key: `orphan_${wtPath}`,
                projectKey: "",
                issueKey: "",
                info: { path: wtPath, branch: wtBranch || "unknown" },
                isOrphaned: true,
                repoPath,
              });
              seenPaths.add(wtPath);
            }
          }
        } catch (e) {
          console.error(`Failed to list worktrees for ${repoPath}:`, e);
        }
      }

      setWorktrees(entries);
      setLoadingWorktrees(false);
    };

    loadAllWorktrees();
  }, []);

  const deleteWorktreeEntry = async (wt: WorktreeEntry) => {
    // Get repo path from worktree info or from orphaned worktree
    const repoPath = wt.repoPath || wt.info.repoPath || null;

    // 1. Try git worktree prune first (cleans up references to missing folders)
    if (repoPath) {
      try {
        await invoke("run_git_command", {
          cwd: repoPath,
          args: ["worktree", "prune"],
        });
      } catch {}
    }

    // 2. Check if folder exists
    const folderExists: boolean = await invoke("check_path_exists", { path: wt.info.path });

    if (folderExists && repoPath) {
      // 3. Try git worktree remove
      try {
        await invoke("run_git_command", {
          cwd: repoPath,
          args: ["worktree", "remove", wt.info.path, "--force"],
        });
      } catch (e) {
        console.error(`git worktree remove failed for ${wt.info.path}:`, e);
      }
    }

    // 4. Delete local branch only (no remote)
    if (repoPath && wt.info.branch && !wt.info.branch.startsWith("detached:")) {
      try {
        await invoke("run_git_command", {
          cwd: repoPath,
          args: ["branch", "-D", wt.info.branch],
        });
      } catch (e) {
        console.error(`Failed to delete local branch ${wt.info.branch}:`, e);
      }
    }

    // 5. Remove from localStorage if not orphaned
    if (!wt.isOrphaned && wt.key) {
      localStorage.removeItem(wt.key);
    }
  };

  const deleteSingleWorktree = async (wt: WorktreeEntry) => {
    setDeletingWorktreeKeys(prev => new Set([...prev, wt.key]));
    try {
      await deleteWorktreeEntry(wt);
      setWorktrees(prev => prev.filter(w => w.key !== wt.key));
    } finally {
      setDeletingWorktreeKeys(prev => {
        const next = new Set(prev);
        next.delete(wt.key);
        return next;
      });
    }
  };

  const [confirmDeleteAll, setConfirmDeleteAll] = useState(false);

  const deleteAllWorktrees = async () => {
    if (worktrees.length === 0) return;
    if (!confirmDeleteAll) {
      setConfirmDeleteAll(true);
      return;
    }
    setConfirmDeleteAll(false);
    setDeletingWorktrees(true);

    // Process deletions in parallel
    const toDelete = [...worktrees];
    await Promise.allSettled(toDelete.map(wt => deleteWorktreeEntry(wt)));
    setWorktrees([]);
    setDeletingWorktrees(false);
  };

  const loadThemes = async (silent = false) => {
    if (!silent) setLoadingThemes(true);
    try {
      const files = await listThemeFiles();
      const themesDir = await getThemesDir();
      const loadedThemes: ThemeListItem[] = [
        { name: DEFAULT_THEME_NAME, filename: null, isDefault: true }
      ];
      for (const file of files) {
        const theme = await loadThemeFromFile(themesDir, file);
        if (theme) {
          loadedThemes.push({ name: theme.name, filename: file, isDefault: false });
        }
      }
      setThemes(loadedThemes);
    } catch (e) {
      console.error("Failed to load themes:", e);
    } finally {
      if (!silent) setLoadingThemes(false);
    }
  };

  // Connection management functions
  const handleSwitchConnection = (connId: string) => {
    setActiveConnectionId(connId);
    setActiveConnId(connId);
    window.location.reload(); // Reload to refresh projects with new connection
  };

  const handleTestAndAddConnection = async () => {
    if (!newConn.username || !newConn.token || !newConn.baseUrl) return;
    setTestingConn(true);
    setConnError(null);

    try {
      const normalizedUrl = newConn.baseUrl.replace(/\/$/, "");
      const response = await fetch(`${normalizedUrl}/rest/api/3/myself`, {
        headers: {
          "Authorization": `Basic ${btoa(`${newConn.username}:${newConn.token}`)}`,
          "Content-Type": "application/json",
        },
      });

      if (!response.ok) {
        if (response.status === 401) throw new Error("Invalid credentials");
        if (response.status === 403) throw new Error("Access denied");
        if (response.status === 404) throw new Error("Invalid URL");
        throw new Error(`Connection failed (${response.status})`);
      }

      const conn: JiraConnection = {
        id: generateConnectionId(),
        name: newConn.name,
        username: newConn.username,
        token: newConn.token,
        baseUrl: normalizedUrl,
      };
      const updated = [...connections, conn];
      saveJiraConnections(updated);
      setActiveConnectionId(conn.id);
      window.location.reload();
    } catch (err: any) {
      setConnError(err.message || "Connection failed");
    } finally {
      setTestingConn(false);
    }
  };

  const handleUpdateConnection = async () => {
    if (!editingConn) return;
    setTestingConn(true);
    setConnError(null);

    try {
      const normalizedUrl = editingConn.baseUrl.replace(/\/$/, "");
      const response = await fetch(`${normalizedUrl}/rest/api/3/myself`, {
        headers: {
          "Authorization": `Basic ${btoa(`${editingConn.username}:${editingConn.token}`)}`,
          "Content-Type": "application/json",
        },
      });

      if (!response.ok) {
        if (response.status === 401) throw new Error("Invalid credentials");
        if (response.status === 403) throw new Error("Access denied");
        if (response.status === 404) throw new Error("Invalid URL");
        throw new Error(`Connection failed (${response.status})`);
      }

      const updated = connections.map(c =>
        c.id === editingConn.id ? { ...editingConn, baseUrl: normalizedUrl } : c
      );
      saveJiraConnections(updated);
      if (editingConn.id === activeConnId) {
        window.location.reload();
      } else {
        setConnections(updated);
        setEditingConn(null);
      }
    } catch (err: any) {
      setConnError(err.message || "Connection failed");
    } finally {
      setTestingConn(false);
    }
  };

  const handleDeleteConnection = (connId: string) => {
    // Delete connection's localStorage data
    const prefix = `${connId}_`;
    const keysToDelete: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith(prefix)) {
        keysToDelete.push(key);
      }
    }
    keysToDelete.forEach(key => localStorage.removeItem(key));

    const updated = connections.filter(c => c.id !== connId);
    setConnections(updated);
    saveJiraConnections(updated);
    if (updated.length === 0) {
      localStorage.removeItem("jira_active_connection_id");
      onLogout();
    } else if (activeConnId === connId) {
      setActiveConnectionId(updated[0].id);
      window.location.reload();
    }
  };

  const [confirmLogout, setConfirmLogout] = useState(false);

  const handleReset = () => {
    if (confirmLogout) {
      localStorage.clear();
      onLogout();
    } else {
      setConfirmLogout(true);
    }
  };

  const handleSelectTheme = async (theme: ThemeListItem) => {
    setCurrentTheme(theme.name);
    saveCurrentThemeName(theme.name);
    if (theme.isDefault) {
      applyTheme(null);
    } else if (theme.filename) {
      const themesDir = await getThemesDir();
      const loaded = await loadThemeFromFile(themesDir, theme.filename);
      if (loaded) applyTheme(loaded);
    }
    window.location.reload();
  };

  const handleDuplicateTheme = async () => {
    const themesDir = await getThemesDir();
    const filename = `custom-theme-${Date.now()}.css`;
    const randomName = generateRandomThemeName();
    const content = DEFAULT_THEME_TEMPLATE.replace("/* Theme: My Custom Theme */", `/* Theme: ${randomName} */`);
    await invoke("write_file", { path: `${themesDir}/${filename}`, content });
    await loadThemes(true);
  };

  const handleEditTheme = async (theme: ThemeListItem, e: React.MouseEvent) => {
    e.stopPropagation();
    if (theme.isDefault || !theme.filename) return;
    try {
      const themesDir = await getThemesDir();
      const content = await invoke<string>("read_file", { path: `${themesDir}/${theme.filename}` });
      setEditorContent(content);
      setEditingTheme(theme.filename);
    } catch (e) {
      console.error("Failed to load theme:", e);
    }
  };

  const handleSaveTheme = async () => {
    if (!editingTheme) return;
    try {
      const themesDir = await getThemesDir();
      await invoke("write_file", { path: `${themesDir}/${editingTheme}`, content: editorContent });
      const parsed = parseThemeCss(editorContent);
      applyTheme(parsed);
      saveCurrentThemeName(parsed.name);
      setCurrentTheme(parsed.name);
      await loadThemes(true);
      setEditingTheme(null);
    } catch (e) {
      console.error("Failed to save theme:", e);
    }
  };

  const handleDeleteTheme = async (theme: ThemeListItem, e: React.MouseEvent) => {
    e.stopPropagation();
    if (theme.isDefault || !theme.filename) return;
    try {
      await deleteThemeFile(theme.filename);
      if (currentTheme === theme.name) {
        saveCurrentThemeName(DEFAULT_THEME_NAME);
        window.location.reload();
        return;
      }
      await loadThemes(true);
    } catch (e) {
      console.error("Failed to delete theme:", e);
    }
  };

  const handleExportTheme = async (theme: ThemeListItem, e: React.MouseEvent) => {
    e.stopPropagation();
    const content = theme.isDefault ? DEFAULT_THEME_TEMPLATE : await (async () => {
      const themesDir = await getThemesDir();
      return invoke<string>("read_file", { path: `${themesDir}/${theme.filename}` });
    })();
    const blob = new Blob([content], { type: "text/css" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = theme.isDefault ? "default-theme.css" : theme.filename!;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleImportTheme = async () => {
    const result = await openDialog({ multiple: false, filters: [{ name: "CSS", extensions: ["css"] }] });
    if (result && typeof result === "string") {
      try {
        const content = await invoke<string>("read_file", { path: result });
        const themesDir = await getThemesDir();
        await invoke("write_file", { path: `${themesDir}/imported-${Date.now()}.css`, content });
        await loadThemes(true);
      } catch (e) {
        console.error("Failed to import theme:", e);
      }
    }
  };

  // Theme editor mode
  if (editingTheme) {
    return (
      <div className="global-settings-panel">
        <div className="filter-header">Edit Theme</div>
        <div className="filter-form theme-editor-form">
          <textarea
            className="theme-editor-textarea"
            value={editorContent}
            onChange={(e) => setEditorContent(e.target.value)}
            spellCheck={false}
          />
          <div className="filter-actions">
            <button className="cancel-btn" onClick={() => setEditingTheme(null)}>Cancel</button>
            <button className="save-btn" onClick={handleSaveTheme}>Save & Apply</button>
          </div>
        </div>
      </div>
    );
  }

  // Connection editing mode
  if (editingConn) {
    return (
      <div className="global-settings-panel">
        <div className="filter-header">Edit Connection</div>
        <div className="filter-form">
          <div className="input-group">
            <label>Connection Name</label>
            <input
              type="text"
              value={editingConn.name}
              onChange={(e) => setEditingConn({ ...editingConn, name: e.target.value })}
              placeholder="My Jira"
            />
          </div>
          <div className="input-group">
            <label>Username (Email)</label>
            <input
              type="text"
              value={editingConn.username}
              onChange={(e) => setEditingConn({ ...editingConn, username: e.target.value })}
              placeholder="your-email@example.com"
            />
          </div>
          <div className="input-group">
            <label>API Token</label>
            <input
              type="password"
              value={editingConn.token}
              onChange={(e) => setEditingConn({ ...editingConn, token: e.target.value })}
              placeholder="••••••••"
            />
          </div>
          <div className="input-group">
            <label>Jira URL</label>
            <input
              type="text"
              value={editingConn.baseUrl}
              onChange={(e) => setEditingConn({ ...editingConn, baseUrl: e.target.value })}
              placeholder="https://your-domain.atlassian.net"
            />
          </div>
          {connError && <div className="setup-error">{connError}</div>}
          <div className="filter-actions">
            <button className="cancel-btn" onClick={() => { setEditingConn(null); setConnError(null); }}>Cancel</button>
            <button className="save-btn" onClick={handleUpdateConnection} disabled={testingConn || !editingConn.name || !editingConn.username || !editingConn.token || !editingConn.baseUrl}>
              {testingConn ? "Testing..." : "Save"}
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Adding new connection mode
  if (addingConn) {
    return (
      <div className="global-settings-panel">
        <div className="filter-header">Add Connection</div>
        <div className="filter-form">
          <div className="input-group">
            <label>Connection Name</label>
            <input
              type="text"
              value={newConn.name}
              onChange={(e) => setNewConn({ ...newConn, name: e.target.value })}
              placeholder="My Jira"
            />
          </div>
          <div className="input-group">
            <label>Username (Email)</label>
            <input
              type="text"
              value={newConn.username}
              onChange={(e) => setNewConn({ ...newConn, username: e.target.value })}
              placeholder="your-email@example.com"
            />
          </div>
          <div className="input-group">
            <label>API Token</label>
            <input
              type="password"
              value={newConn.token}
              onChange={(e) => setNewConn({ ...newConn, token: e.target.value })}
              placeholder="••••••••"
            />
          </div>
          <div className="input-group">
            <label>Jira URL</label>
            <input
              type="text"
              value={newConn.baseUrl}
              onChange={(e) => setNewConn({ ...newConn, baseUrl: e.target.value })}
              placeholder="https://your-domain.atlassian.net"
            />
          </div>
          {connError && <div className="setup-error">{connError}</div>}
          <div className="filter-actions">
            <button className="cancel-btn" onClick={() => { setAddingConn(false); setConnError(null); setNewConn({ name: "", username: "", token: "", baseUrl: "" }); }}>Cancel</button>
            <button
              className="save-btn"
              onClick={handleTestAndAddConnection}
              disabled={testingConn || !newConn.name || !newConn.username || !newConn.token || !newConn.baseUrl}
            >
              {testingConn ? "Testing..." : "Add"}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="global-settings-panel">
      <div className="filter-header">Settings</div>
      <div className="filter-form">
        <div className="filter-section">
          <div className="filter-section-title">JIRA CONNECTIONS</div>
          <div className="input-group">
            <label>Active Connection</label>
            <div className="theme-select-list">
            {connections.map((conn) => (
              <div
                key={conn.id}
                className={`theme-select-item ${activeConnId === conn.id ? "active" : ""}`}
                onClick={() => handleSwitchConnection(conn.id)}
              >
                <span className="theme-select-name">
                  {conn.name}
                  <span style={{ opacity: 0.5, marginLeft: 8, fontSize: "0.85em" }}>
                    {new URL(conn.baseUrl).hostname}
                  </span>
                </span>
                <div className="theme-select-actions">
                  <button className="icon-btn-sm" onClick={(e) => { e.stopPropagation(); setEditingConn(conn); }} title="Edit">
                    <EditIcon />
                  </button>
                  {connections.length > 1 && (
                    <button className="icon-btn-sm" onClick={(e) => { e.stopPropagation(); handleDeleteConnection(conn.id); }} title="Delete">
                      <TrashIcon />
                    </button>
                  )}
                </div>
              </div>
            ))}
            </div>
          </div>
          <div className="chip-group" style={{ marginTop: 12 }}>
            <button className="chip" onClick={() => setAddingConn(true)}>
              + Add Connection
            </button>
          </div>
        </div>

        <div className="filter-section">
          <div className="filter-section-title">THEME</div>
          <div className="input-group">
            <label>Current Theme</label>
            {loadingThemes ? (
              <span className="loading-text">Loading...</span>
            ) : (
              <div className="theme-select-list">
                {themes.map((theme) => (
                  <div
                    key={theme.filename || "default"}
                    className={`theme-select-item ${currentTheme === theme.name ? "active" : ""}`}
                    onClick={() => handleSelectTheme(theme)}
                  >
                    <span className="theme-select-name">{theme.name}</span>
                    <div className="theme-select-actions">
                      <button className="icon-btn-sm" onClick={(e) => handleExportTheme(theme, e)} title="Export">
                        <DownloadIcon />
                      </button>
                      {!theme.isDefault && (
                        <>
                          <button className="icon-btn-sm" onClick={(e) => handleEditTheme(theme, e)} title="Edit">
                            <EditIcon />
                          </button>
                          <button className="icon-btn-sm" onClick={(e) => handleDeleteTheme(theme, e)} title="Delete">
                            <TrashIcon />
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
          <div className="chip-group">
            <button className="chip" onClick={handleDuplicateTheme}>
              <CopyIcon /> New
            </button>
            <button className="chip" onClick={handleImportTheme}>
              <UploadIcon /> Import
            </button>
          </div>
        </div>

        <div className="filter-section">
          <div className="filter-section-title">SHORTCUTS</div>
          <div className="shortcut-list">
            {(Object.keys(SHORTCUT_LABELS) as ShortcutKey[]).map((key) => (
              <div key={key} className="shortcut-item">
                <span className="shortcut-label">{SHORTCUT_LABELS[key]}</span>
                <button
                  className={`shortcut-key ${recordingShortcut === key ? "recording" : ""}`}
                  onClick={() => setRecordingShortcut(recordingShortcut === key ? null : key)}
                >
                  {recordingShortcut === key ? "Press keys..." : formatShortcut(shortcuts[key])}
                </button>
              </div>
            ))}
          </div>
          <div className="chip-group">
            <button className="chip" onClick={resetShortcuts}>Reset to Default</button>
          </div>
        </div>

        <div className="filter-section">
          <div className="filter-section-title">WORKTREES</div>
          {loadingWorktrees ? (
            <span className="loading-text">Scanning worktrees...</span>
          ) : worktrees.length === 0 ? (
            <p className="settings-desc">No worktrees found.</p>
          ) : (
            <>
              <div className="worktree-list">
                {worktrees.map((wt) => (
                  <div key={wt.key} className={`worktree-item ${deletingWorktreeKeys.has(wt.key) ? "deleting" : ""} ${wt.isOrphaned ? "orphaned" : ""}`}>
                    {deletingWorktreeKeys.has(wt.key) ? (
                      <div className="worktree-info">
                        <Spinner />
                        <span className="worktree-deleting-text">Deleting...</span>
                      </div>
                    ) : (
                      <>
                        <div className="worktree-info">
                          {wt.isOrphaned ? (
                            <span className="worktree-orphaned-label">Orphaned</span>
                          ) : !visibleIssueKeys.has(wt.issueKey) ? (
                            <div className="worktree-issue-wrapper">
                              <span className="worktree-issue">{wt.issueKey}</span>
                              <span className="worktree-hidden-label">Hidden</span>
                            </div>
                          ) : (
                            <span className="worktree-issue">{wt.issueKey}</span>
                          )}
                          <span className="worktree-branch">{wt.info.branch}</span>
                          {(wt.info.repoPath || wt.repoPath) && (
                            <span className="worktree-repo" title={wt.info.repoPath || wt.repoPath}>
                              {(wt.info.repoPath || wt.repoPath)?.split("/").pop()}
                            </span>
                          )}
                        </div>
                        <button
                          className="icon-btn-sm"
                          onClick={() => deleteSingleWorktree(wt)}
                          disabled={deletingWorktrees}
                          title="Delete"
                        >
                          <TrashIcon />
                        </button>
                      </>
                    )}
                  </div>
                ))}
              </div>
              <div className="chip-group">
                {confirmDeleteAll ? (
                  <>
                    <button className="chip danger" onClick={deleteAllWorktrees} disabled={deletingWorktrees}>
                      {deletingWorktrees ? "Deleting..." : "Yes, Delete All"}
                    </button>
                    <button className="chip" onClick={() => setConfirmDeleteAll(false)} disabled={deletingWorktrees}>
                      Cancel
                    </button>
                  </>
                ) : (
                  <button
                    className="chip danger"
                    onClick={deleteAllWorktrees}
                    disabled={deletingWorktrees}
                  >
                    {deletingWorktrees ? `Deleting... (${worktrees.length} left)` : `Delete All (${worktrees.length})`}
                  </button>
                )}
              </div>
            </>
          )}
        </div>

        <div className="filter-section">
          <div className="filter-section-title">DANGER ZONE</div>
          <p className="settings-desc">
            {confirmLogout ? "Are you sure? This will reset all settings." : "Reset all settings and return to setup screen."}
          </p>
          <div className="chip-group">
            {confirmLogout ? (
              <>
                <button className="chip danger" onClick={handleReset}>Yes, Logout</button>
                <button className="chip" onClick={() => setConfirmLogout(false)}>Cancel</button>
              </>
            ) : (
              <button className="chip danger" onClick={handleReset}>Reset & Logout</button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

const DownloadIcon = () => (
  <svg className="icon-xs" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    <polyline points="7 10 12 15 17 10" />
    <line x1="12" y1="15" x2="12" y2="3" />
  </svg>
);

const UploadIcon = () => (
  <svg className="icon-xs" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    <polyline points="17 8 12 3 7 8" />
    <line x1="12" y1="3" x2="12" y2="15" />
  </svg>
);

const CopyIcon = () => (
  <svg className="icon-xs" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
  </svg>
);

const CheckIcon = () => (
  <svg className="icon-xs" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="20 6 9 17 4 12" />
  </svg>
);

type ThemeListItem = {
  name: string;
  filename: string | null; // null for default theme
  isDefault: boolean;
};

const EditIcon = () => (
  <svg className="icon-xs" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
  </svg>
);

const CloseIcon = () => (
  <svg className="icon-xs" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <line x1="18" y1="6" x2="6" y2="18" />
    <line x1="6" y1="6" x2="18" y2="18" />
  </svg>
);

const CalendarIcon = () => (
  <svg className="icon-xs" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="4" width="18" height="18" rx="2" />
    <line x1="16" y1="2" x2="16" y2="6" />
    <line x1="8" y1="2" x2="8" y2="6" />
    <line x1="3" y1="10" x2="21" y2="10" />
  </svg>
);

const ChevronLeftIcon = () => (
  <svg className="icon-xs" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="15 18 9 12 15 6" />
  </svg>
);

const ChevronRightIcon = () => (
  <svg className="icon-xs" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="9 18 15 12 9 6" />
  </svg>
);

function DatePicker({
  value,
  onChange,
  onClose,
}: {
  value: string;
  onChange: (date: string | null) => void;
  onClose: () => void;
}) {
  const today = new Date();
  const [viewYear, setViewYear] = useState(() => {
    if (value) {
      const [y] = value.split("-").map(Number);
      return y;
    }
    return today.getFullYear();
  });
  const [viewMonth, setViewMonth] = useState(() => {
    if (value) {
      const [, m] = value.split("-").map(Number);
      return m - 1;
    }
    return today.getMonth();
  });

  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleEscape);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [onClose]);

  const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
  const firstDayOfMonth = new Date(viewYear, viewMonth, 1).getDay();
  const days: (number | null)[] = [];
  for (let i = 0; i < firstDayOfMonth; i++) days.push(null);
  for (let i = 1; i <= daysInMonth; i++) days.push(i);

  const selectedDate = value ? (() => {
    const [y, m, d] = value.split("-").map(Number);
    return { year: y, month: m - 1, day: d };
  })() : null;

  const isToday = (day: number) =>
    viewYear === today.getFullYear() && viewMonth === today.getMonth() && day === today.getDate();

  const isSelected = (day: number) =>
    selectedDate && viewYear === selectedDate.year && viewMonth === selectedDate.month && day === selectedDate.day;

  const handleSelect = (day: number) => {
    const m = String(viewMonth + 1).padStart(2, "0");
    const d = String(day).padStart(2, "0");
    onChange(`${viewYear}-${m}-${d}`);
    onClose();
  };

  const prevMonth = () => {
    if (viewMonth === 0) {
      setViewMonth(11);
      setViewYear(viewYear - 1);
    } else {
      setViewMonth(viewMonth - 1);
    }
  };

  const nextMonth = () => {
    if (viewMonth === 11) {
      setViewMonth(0);
      setViewYear(viewYear + 1);
    } else {
      setViewMonth(viewMonth + 1);
    }
  };

  const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const dayNames = ["S", "M", "T", "W", "T", "F", "S"];

  return (
    <div className="date-picker" ref={containerRef}>
      <div className="date-picker-header">
        <button className="date-picker-nav" onClick={prevMonth}><ChevronLeftIcon /></button>
        <span className="date-picker-title">{monthNames[viewMonth]} {viewYear}</span>
        <button className="date-picker-nav" onClick={nextMonth}><ChevronRightIcon /></button>
      </div>
      <div className="date-picker-days-header">
        {dayNames.map((d, i) => (
          <span key={i} className={`date-picker-day-name ${i === 0 ? "sunday" : i === 6 ? "saturday" : ""}`}>{d}</span>
        ))}
      </div>
      <div className="date-picker-grid">
        {days.map((day, i) => (
          <button
            key={i}
            className={`date-picker-day ${day === null ? "empty" : ""} ${day && isToday(day) ? "today" : ""} ${day && isSelected(day) ? "selected" : ""} ${i % 7 === 0 ? "sunday" : i % 7 === 6 ? "saturday" : ""}`}
            onClick={() => day && handleSelect(day)}
            disabled={day === null}
          >
            {day}
          </button>
        ))}
      </div>
      <div className="date-picker-footer">
        <button className="date-picker-clear" onClick={() => { onChange(null); onClose(); }}>Clear</button>
        <button className="date-picker-today" onClick={() => handleSelect(today.getDate())}>Today</button>
      </div>
    </div>
  );
}

// Terminal Group: each group shows side by side, each group has its own tabs
type TerminalGroup = {
  id: number;
  terminals: number[]; // session IDs
  activeTerminal: number | null;
  flex: number; // flex-grow value for width
};

// Global terminal state per issue (persists across component remounts)
type IssueTerminalState = {
  groups: TerminalGroup[];
  activeGroupId: number | null;
  nextGroupId: number;
  terminalHeight: number;
  isDeleting?: boolean; // Worktree deletion in progress
  isCreating?: boolean; // Worktree creation in progress
  isAutoCreatingTerminal?: boolean; // Auto-creating first terminal in progress
};

const issueTerminalStates = new Map<string, IssueTerminalState>();

// Request IDs to handle concurrent operations per issue
const deleteRequestIds = new Map<string, number>();
const createRequestIds = new Map<string, number>();

function getIssueTerminalState(issueKey: string): IssueTerminalState {
  if (!issueTerminalStates.has(issueKey)) {
    issueTerminalStates.set(issueKey, {
      groups: [],
      activeGroupId: null,
      nextGroupId: 1,
      terminalHeight: 500,
    });
  }
  return issueTerminalStates.get(issueKey)!;
}

function setIssueTerminalState(issueKey: string, state: Partial<IssueTerminalState>) {
  const current = getIssueTerminalState(issueKey);
  issueTerminalStates.set(issueKey, { ...current, ...state });
}

const MaximizeIcon = () => (
  <svg className="icon-xs" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <rect x="3" y="3" width="18" height="18" rx="2" />
  </svg>
);

const MinimizeIcon = () => (
  <svg className="icon-xs" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <polyline points="4 14 10 14 10 20" />
    <polyline points="20 10 14 10 14 4" />
    <line x1="14" y1="10" x2="21" y2="3" />
    <line x1="3" y1="21" x2="10" y2="14" />
  </svg>
);

const SplitIcon = () => (
  <svg className="icon-xs" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <line x1="12" y1="3" x2="12" y2="21" />
  </svg>
);

const TrashIcon = () => (
  <svg className="icon-xs" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <polyline points="3 6 5 6 21 6" />
    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
  </svg>
);

// Global cache for terminal instances - persists across component remounts
// Simple terminal cache
const terminalCache = new Map<number, {
  term: Terminal;
  fitAddon: FitAddon;
  cleanup?: () => void;
  onSessionEnd?: () => void;
  onTitleChange?: (title: string) => void;
}>();

// Global terminal titles (sessionId -> title)
const terminalTitles = new Map<number, string>();

// Find safe boundary to write, excluding incomplete escape sequences at the end
function findSafeWriteBoundary(text: string): number {
  const len = text.length;
  if (len === 0) return 0;

  // Look for ESC (0x1b) in the last 64 chars
  const searchStart = Math.max(0, len - 64);
  let lastEsc = -1;

  for (let i = len - 1; i >= searchStart; i--) {
    if (text.charCodeAt(i) === 0x1b) {
      lastEsc = i;
      break;
    }
  }

  if (lastEsc === -1) return len; // No ESC found

  // Check if sequence starting at lastEsc is complete
  const seq = text.slice(lastEsc);

  if (isEscapeSequenceComplete(seq)) {
    return len; // Complete, safe to write all
  }

  return lastEsc; // Incomplete, write up to ESC
}

function isEscapeSequenceComplete(seq: string): boolean {
  if (seq.length === 0 || seq.charCodeAt(0) !== 0x1b) return true;
  if (seq.length === 1) return false; // Just ESC

  const second = seq.charCodeAt(1);

  // CSI: ESC [ ... (ends with 0x40-0x7E)
  if (second === 0x5b) { // '['
    if (seq.length === 2) return false;
    for (let i = 2; i < seq.length; i++) {
      const c = seq.charCodeAt(i);
      if (c >= 0x40 && c <= 0x7e) return true;
    }
    return false;
  }

  // OSC: ESC ] ... (ends with BEL or ST)
  if (second === 0x5d) { // ']'
    for (let i = 2; i < seq.length; i++) {
      if (seq.charCodeAt(i) === 0x07) return true; // BEL
      if (seq.charCodeAt(i) === 0x1b && i + 1 < seq.length && seq.charCodeAt(i + 1) === 0x5c) {
        return true; // ST (ESC \)
      }
    }
    return false;
  }

  // DCS: ESC P ... (ends with ST)
  if (second === 0x50) { // 'P'
    for (let i = 2; i < seq.length; i++) {
      if (seq.charCodeAt(i) === 0x1b && i + 1 < seq.length && seq.charCodeAt(i + 1) === 0x5c) {
        return true;
      }
    }
    return false;
  }

  // Single char sequences - complete
  return true;
}

function TerminalInstance({ sessionId, fontSize, onSessionEnd, onTitleChange }: {
  sessionId: number;
  fontSize: number;
  onSessionEnd?: () => void;
  onTitleChange?: (title: string) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);

  // Update callbacks in cache
  useEffect(() => {
    const cached = terminalCache.get(sessionId);
    if (cached) {
      cached.onSessionEnd = onSessionEnd;
      cached.onTitleChange = onTitleChange;
    }
  }, [sessionId, onSessionEnd, onTitleChange]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let cached = terminalCache.get(sessionId);

    if (cached) {
      // Reattach existing terminal
      container.innerHTML = '';
      container.appendChild(cached.term.element!);
      cached.fitAddon.fit();
      setReady(true);
      return;
    }

    // Create new terminal with minimal config
    // Get terminal theme from CSS variables
    const getTerminalTheme = () => {
      const get = (name: string) => getCssVar(name) || undefined;
      return {
        background: get("--terminal-bg") || "#09090b",
        foreground: get("--terminal-fg") || "#a1a1aa",
        cursor: get("--terminal-cursor") || "#a1a1aa",
        selectionBackground: "rgba(255, 255, 255, 0.15)",
        black: get("--terminal-black") || "#09090b",
        brightBlack: get("--terminal-bright-black") || "#52525b",
        white: get("--terminal-white") || "#e4e4e7",
        brightWhite: get("--terminal-bright-white") || "#fafafa",
        blue: get("--terminal-blue") || "#60a5fa",
        brightBlue: get("--terminal-bright-blue") || "#93c5fd",
        cyan: get("--terminal-cyan") || "#22d3ee",
        brightCyan: get("--terminal-bright-cyan") || "#67e8f9",
        green: get("--terminal-green") || "#4ade80",
        brightGreen: get("--terminal-bright-green") || "#86efac",
        magenta: get("--terminal-magenta") || "#c084fc",
        brightMagenta: get("--terminal-bright-magenta") || "#d8b4fe",
        red: get("--terminal-red") || "#f87171",
        brightRed: get("--terminal-bright-red") || "#fca5a5",
        yellow: get("--terminal-yellow") || "#facc15",
        brightYellow: get("--terminal-bright-yellow") || "#fde047",
      };
    };

    const term = new Terminal({
      cursorBlink: true,
      fontSize,
      fontFamily: getCssVar("--font-family-mono") || '"SF Mono", ui-monospace, monospace',
      theme: getTerminalTheme(),
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);

    // Web links addon - cmd+click to open URLs
    const webLinksAddon = new WebLinksAddon((event, uri) => {
      if (event.metaKey || event.ctrlKey) {
        openUrl(uri);
      }
    });
    term.loadAddon(webLinksAddon);

    // Open terminal
    term.open(container);

    // Enable WebGL for hardware acceleration
    try {
      const webglAddon = new WebglAddon();
      term.loadAddon(webglAddon);
    } catch (e) {
      console.warn("WebGL addon failed:", e);
    }

    // Fit after open
    requestAnimationFrame(() => {
      fitAddon.fit();
      invoke("resize_pty", { sessionId, rows: term.rows, cols: term.cols }).catch(() => {});
      setReady(true);
    });

    // Handle special keys only
    term.attachCustomKeyEventHandler((e) => {
      if (e.type === 'keydown') {
        // Maximize terminal shortcut: let it bubble to window
        if (matchesShortcut(e, getShortcuts().maximizeTerminal)) {
          return false;
        }

        // Cmd+K to clear terminal (like macOS Terminal)
        if (e.metaKey && e.key === 'k' && !e.ctrlKey && !e.altKey && !e.shiftKey) {
          term.clear();
          return false;
        }

        // Handle Option+Arrow keys - send macOS-style sequences
        if (e.altKey && !e.ctrlKey && !e.metaKey) {
          if (e.key === 'ArrowLeft') {
            invoke("write_to_pty", { sessionId, data: '\x1bb' }).catch(console.error);
            return false;
          } else if (e.key === 'ArrowRight') {
            invoke("write_to_pty", { sessionId, data: '\x1bf' }).catch(console.error);
            return false;
          } else if (e.key === 'Backspace') {
            invoke("write_to_pty", { sessionId, data: '\x1b\x7f' }).catch(console.error);
            return false;
          }
        }

        // Block printable character keydown - handle via beforeinput for Korean IME
        if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
          return false;
        }
      }
      return true;
    });

    // WKWebView Korean IME Bridge
    const xtermTextarea = container.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement;

    if (xtermTextarea) {
      let isComposing = false;
      let composingText = '';

      const isKorean = (ch: string) => {
        if (!ch) return false;
        const code = ch.charCodeAt(0);
        return (code >= 0x1100 && code <= 0x11FF) ||
               (code >= 0x3130 && code <= 0x318F) ||
               (code >= 0xAC00 && code <= 0xD7AF);
      };

      xtermTextarea.addEventListener('beforeinput', (e: InputEvent) => {
        const data = e.data || '';
        const inputType = e.inputType;

        // 한글 조합 완료
        if (inputType === 'insertFromComposition') {
          e.preventDefault();
          if (data) {
            invoke("write_to_pty", { sessionId, data }).catch(console.error);
          }
          xtermTextarea.dispatchEvent(new CompositionEvent('compositionend', { data: '' }));
          isComposing = false;
          composingText = '';
          return;
        }

        // 한글 조합 중
        if (inputType === 'insertReplacementText' || inputType === 'insertCompositionText' ||
            (inputType === 'insertText' && isKorean(data))) {
          e.preventDefault();
          if (!isComposing) {
            isComposing = true;
            xtermTextarea.dispatchEvent(new CompositionEvent('compositionstart', { data: '' }));
          }
          composingText = data;
          xtermTextarea.dispatchEvent(new CompositionEvent('compositionupdate', { data }));
          return;
        }

        // 영문/숫자/기호/스페이스
        if (inputType === 'insertText') {
          e.preventDefault();
          if (isComposing) {
            if (composingText) {
              invoke("write_to_pty", { sessionId, data: composingText }).catch(console.error);
            }
            xtermTextarea.dispatchEvent(new CompositionEvent('compositionend', { data: '' }));
            isComposing = false;
            composingText = '';
          }
          if (data) {
            invoke("write_to_pty", { sessionId, data }).catch(console.error);
          }
          return;
        }
      });
    }

    term.onData((data) => {
      // 단일 printable 문자는 beforeinput에서 처리됨
      // 제어 문자(0-31), DEL/백스페이스(127), escape 시퀀스(길이>1)만 여기서 처리
      if (data.length === 1) {
        const code = data.charCodeAt(0);
        if (code >= 32 && code !== 127) {
          return;
        }
      }
      invoke("write_to_pty", { sessionId, data }).catch(console.error);
    });

    // Event-based output handling
    let unlistenOutput: (() => void) | null = null;
    let unlistenEnd: (() => void) | null = null;

    // Foreground process polling (250ms)
    // Debounce to avoid flickering from short-lived processes
    let lastTitle = "";
    let pendingTitle = "";
    let pendingCount = 0;
    let polling = true;
    const pollForegroundProcess = async () => {
      while (polling) {
        try {
          const name = await invoke<string>("get_pty_foreground_process", { sessionId });
          if (name && name !== lastTitle) {
            // Require same value twice in a row to update (filters out short-lived processes)
            if (name === pendingTitle) {
              pendingCount++;
              if (pendingCount >= 2) {
                lastTitle = name;
                terminalTitles.set(sessionId, name);
                const cached = terminalCache.get(sessionId);
                cached?.onTitleChange?.(name);
                pendingCount = 0;
              }
            } else {
              pendingTitle = name;
              pendingCount = 1;
            }
          }
        } catch {}
        await new Promise(r => setTimeout(r, 150));
      }
    };
    pollForegroundProcess();

    const setupListeners = async () => {
      // Buffer for incomplete escape sequences
      let pendingData = '';

      unlistenOutput = await listen<string>(`pty-output-${sessionId}`, (event) => {
        const data = pendingData + event.payload;
        const safeEnd = findSafeWriteBoundary(data);

        if (safeEnd > 0) {
          term.write(data.slice(0, safeEnd));
        }
        pendingData = data.slice(safeEnd);

        // Prevent memory buildup - force flush if too large
        if (pendingData.length > 256) {
          term.write(pendingData);
          pendingData = '';
        }
      });

      unlistenEnd = await listen(`pty-end-${sessionId}`, () => {
        const c = terminalCache.get(sessionId);
        if (c) {
          c.cleanup?.();
          c.onSessionEnd?.();
        }
      });

      // Store cleanup function
      const cached = terminalCache.get(sessionId);
      if (cached) {
        cached.cleanup = () => {
          unlistenOutput?.();
          unlistenEnd?.();
        };
      }
    };

    setupListeners();

    // Cache it
    terminalCache.set(sessionId, { term, fitAddon, onSessionEnd, onTitleChange });

    return () => {};
  }, [sessionId]);

  // Handle resize
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const observer = new ResizeObserver(() => {
      const cached = terminalCache.get(sessionId);
      if (cached) {
        cached.fitAddon.fit();
        invoke("resize_pty", {
          sessionId,
          rows: cached.term.rows,
          cols: cached.term.cols
        }).catch(() => {});
      }
    });

    observer.observe(container);
    return () => observer.disconnect();
  }, [sessionId]);

  // Handle font size change
  useEffect(() => {
    const cached = terminalCache.get(sessionId);
    if (cached) {
      cached.term.options.fontSize = fontSize;
      cached.fitAddon.fit();
      invoke("resize_pty", {
        sessionId,
        rows: cached.term.rows,
        cols: cached.term.cols
      }).catch(() => {});
    }
  }, [sessionId, fontSize]);

  return (
    <div
      className="terminal-instance"
      ref={containerRef}
      style={{ opacity: ready ? 1 : 0 }}
      onClick={() => terminalCache.get(sessionId)?.term.focus()}
    />
  );
}

// Extract display name from terminal title (last path component or command name)
function getTerminalDisplayName(title: string | undefined): string {
  if (!title) return "zsh";
  // If it's a path, get the last component
  const parts = title.split(/[/:\\]/);
  const last = parts[parts.length - 1] || title;
  // Limit length
  return last.length > 20 ? last.slice(0, 20) + "…" : last;
}

function TerminalGroupView({
  group,
  isActive,
  onActivate,
  onAddTerminal,
  onCloseTerminal,
  onSelectTerminal,
  onCloseGroup,
  fontSize,
}: {
  group: TerminalGroup;
  isActive: boolean;
  onActivate: () => void;
  onAddTerminal: () => void;
  onCloseTerminal: (id: number) => void;
  onSelectTerminal: (id: number) => void;
  onCloseGroup: () => void;
  fontSize: number;
}) {
  const [titles, setTitles] = useState<Record<number, string>>(() => {
    // Initialize from global cache
    const initial: Record<number, string> = {};
    for (const id of group.terminals) {
      const cached = terminalTitles.get(id);
      if (cached) initial[id] = cached;
    }
    return initial;
  });

  const handleTitleChange = useCallback((sessionId: number, title: string) => {
    setTitles(prev => ({ ...prev, [sessionId]: title }));
  }, []);

  return (
    <div className={`terminal-group ${isActive ? "active" : ""}`} style={{ flex: group.flex }} onClick={onActivate}>
      <div className="terminal-group-header">
        <div className="terminal-group-tabs">
          {group.terminals.map((id) => (
            <div
              key={id}
              className={`terminal-group-tab ${group.activeTerminal === id ? "active" : ""}`}
              onClick={(e) => { e.stopPropagation(); onSelectTerminal(id); }}
            >
              <span>{getTerminalDisplayName(titles[id])}</span>
              <button
                className="terminal-group-tab-close"
                onClick={(e) => { e.stopPropagation(); onCloseTerminal(id); }}
              >
                <CloseIcon />
              </button>
            </div>
          ))}
        </div>
        <div className="terminal-group-actions">
          <button className="terminal-group-btn" onClick={(e) => { e.stopPropagation(); onAddTerminal(); }} title="New Terminal">
            <PlusIcon />
          </button>
          <button className="terminal-group-btn" onClick={(e) => { e.stopPropagation(); onCloseGroup(); }} title="Close Group">
            <TrashIcon />
          </button>
        </div>
      </div>
      <div className="terminal-group-content">
        {group.terminals.map((id) => (
          <div key={id} style={{ display: group.activeTerminal === id ? 'block' : 'none', position: 'relative', flex: 1, width: '100%', height: '100%' }}>
            <TerminalInstance sessionId={id} fontSize={fontSize} onSessionEnd={() => onCloseTerminal(id)} onTitleChange={(title) => handleTitleChange(id, title)} />
          </div>
        ))}
      </div>
    </div>
  );
}

function TerminalPanel({ issueKey, projectKey, isCollapsed, setIsCollapsed, isMaximized, setIsMaximized, onWorktreeChange }: { issueKey: string; projectKey: string; isCollapsed: boolean; setIsCollapsed: (v: boolean) => void; isMaximized: boolean; setIsMaximized: (v: boolean) => void; onWorktreeChange?: () => void }) {
  // Track current issueKey for async callbacks (update during render, not in useEffect)
  const issueKeyRef = useRef(issueKey);
  issueKeyRef.current = issueKey; // Sync update during render to avoid timing issues

  // Load state from global store
  const savedState = getIssueTerminalState(issueKey);
  const [worktreeInfo, setWorktreeInfo] = useState<WorktreeInfo | null>(() => getIssueWorktree(projectKey, issueKey));
  const [repoPath, setRepoPath] = useState<string | null>(() => {
    const wt = getIssueWorktree(projectKey, issueKey);
    return wt?.repoPath || null;
  });
  const [groups, setGroupsState] = useState<TerminalGroup[]>(savedState.groups);
  const [activeGroupId, setActiveGroupIdState] = useState<number | null>(savedState.activeGroupId);
  const [nextGroupId, setNextGroupIdState] = useState(savedState.nextGroupId);
  const [terminalHeight, setTerminalHeightState] = useState(savedState.terminalHeight);
  const [terminalFontSize] = useState(getTerminalFontSize);
  const [resizingGroupIndex, setResizingGroupIndex] = useState<number | null>(null);
  const groupsContainerRef = useRef<HTMLDivElement>(null);

  // Worktree setup state
  const [branches, setBranches] = useState<string[]>([]);
  const [currentBranch, setCurrentBranch] = useState<string>("");
  const [branchName, setBranchName] = useState("");
  const [baseBranch, setBaseBranch] = useState("");
  const [isCreatingWorktree, setIsCreatingWorktree] = useState(false);
  const [worktreeError, setWorktreeError] = useState<string | null>(null);
  const [branchMode, setBranchMode] = useState<"new" | "existing">("new");
  const [selectedExistingBranch, setSelectedExistingBranch] = useState("");
  const [pullingBranch, setPullingBranch] = useState<string | null>(null);
  const [pullResult, setPullResult] = useState<string | null>(null);
  const [lastPulledBranch, setLastPulledBranch] = useState<string | null>(null);
  const pullResultTimeoutRef = useRef<number | null>(null);

  // Get project's used repo paths
  const getProjectRepoPaths = (): string[] => {
    const allWorktrees = getAllWorktrees();
    const repoPaths = new Set<string>();
    for (const wt of allWorktrees) {
      if (wt.projectKey === projectKey && wt.info.repoPath) {
        repoPaths.add(wt.info.repoPath);
      }
    }
    return Array.from(repoPaths);
  };
  const [projectRepoPaths, setProjectRepoPaths] = useState<string[]>(() => getProjectRepoPaths());

  // Get branches used by other issues in same project
  const getUsedBranches = (): Set<string> => {
    const allWorktrees = getAllWorktrees();
    const usedBranches = new Set<string>();
    for (const wt of allWorktrees) {
      if (wt.projectKey === projectKey && wt.issueKey !== issueKey && wt.info.branch) {
        usedBranches.add(wt.info.branch);
      }
    }
    return usedBranches;
  };

  // Branch name validation
  const isValidBranchName = (name: string): boolean => {
    if (!name) return true; // Empty is valid (will use issueKey as default)
    // Git branch naming rules
    if (name.startsWith(".") || name.startsWith("-") || name.startsWith("/")) return false;
    if (name.endsWith(".") || name.endsWith("/") || name.endsWith(".lock")) return false;
    if (name.includes("..") || name.includes("//") || name.includes("@{")) return false;
    // Only allow ASCII alphanumeric, dash, underscore, slash, dot
    if (!/^[a-zA-Z0-9\-_/.]+$/.test(name)) return false;
    return true;
  };
  const branchNameError = branchMode === "new" && branchName
    ? !isValidBranchName(branchName)
      ? "Invalid branch name"
      : branchName === currentBranch
        ? "Cannot use current branch"
        : getUsedBranches().has(branchName)
          ? "Branch is in use by another issue"
          : null
    : null;

  // Worktree popover state
  const [showWorktreePopover, setShowWorktreePopover] = useState(false);
  const [isDeletingWorktree, setIsDeletingWorktree] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [pathCopied, setPathCopied] = useState(false);
  const [branchCopied, setBranchCopied] = useState(false);

  // PR state
  const [prList, setPrList] = useState<Array<{ url: string; state: string; isDraft: boolean; number: number; headRefName: string; baseRefName: string; reviewDecision?: string }>>([]);
  const currentPrCheckRef = useRef<{ branch: string; repoPath: string } | null>(null);



  // Handle repository selection
  const selectRepository = async () => {
    const selected = await openDialog({
      directory: true,
      multiple: false,
      title: "Select Repository Folder",
    });
    if (selected) {
      const path = selected as string;
      setRepoPath(path);
    }
  };

  // Load branches function
  const branchLoadRequestIdRef = useRef(0);
  const loadBranches = (targetRepoPath: string, updateBaseBranch: boolean = true) => {
    const currentRequestId = ++branchLoadRequestIdRef.current;

    Promise.all([
      invoke("run_git_command", { cwd: targetRepoPath, args: ["branch"] }),
      invoke("run_git_command", { cwd: targetRepoPath, args: ["rev-parse", "--abbrev-ref", "HEAD"] }),
    ]).then(([branchOutput, currentOutput]) => {
      if (branchLoadRequestIdRef.current !== currentRequestId) return;
      const branchList = (branchOutput as string)
        .split("\n")
        .map(b => b.trim().replace(/^[\*\+]\s*/, ""))
        .filter(b => b);
      setBranches(branchList);
      const current = (currentOutput as string).trim();
      setCurrentBranch(current);
      if (updateBaseBranch) {
        setBaseBranch(current);
      }
    }).catch(e => {
      if (branchLoadRequestIdRef.current !== currentRequestId) return;
      console.error("Failed to load branches:", e);
      setWorktreeError("Failed to load branches. Is this a git repository?");
    });
  };


  // Pull specific branch
  const pullBranch = async (branchName: string) => {
    if (!repoPath || pullingBranch) return;

    // Clear any existing timeout
    if (pullResultTimeoutRef.current) {
      clearTimeout(pullResultTimeoutRef.current);
      pullResultTimeoutRef.current = null;
    }

    setPullingBranch(branchName);
    setLastPulledBranch(branchName);
    setWorktreeError(null);
    setPullResult(null);
    try {
      let result: string;

      // Current branch requires different approach
      if (branchName === currentBranch) {
        // Use git pull for current branch
        result = await invoke<string>("run_git_command", { cwd: repoPath, args: ["pull"] });
      } else {
        // Fetch into non-current branch without checkout
        result = await invoke<string>("run_git_command", { cwd: repoPath, args: ["fetch", "origin", `${branchName}:${branchName}`] });
      }

      // Parse result to determine if there were changes
      if (result.includes("Already up to date") || result.includes("Already up-to-date") || result.trim() === "") {
        setPullResult("✓ Already up to date");
      } else if (result.includes("Updating") || result.includes("Fast-forward") || result.includes("->")) {
        setPullResult("✓ Updated successfully");
      } else {
        setPullResult("✓ Pull completed");
      }

      loadBranches(repoPath, false);

      // Clear success message after 3 seconds
      pullResultTimeoutRef.current = setTimeout(() => {
        setPullResult(null);
        setLastPulledBranch(null);
        pullResultTimeoutRef.current = null;
      }, 3000);
    } catch (e: any) {
      console.error("Failed to pull branch:", e);
      setWorktreeError(`Failed to pull ${branchName}: ` + (e?.toString() || "Unknown error"));
      setLastPulledBranch(null);
      // Clear any pending timeout on error
      if (pullResultTimeoutRef.current) {
        clearTimeout(pullResultTimeoutRef.current);
        pullResultTimeoutRef.current = null;
      }
    } finally {
      setPullingBranch(null);
    }
  };

  // Load branches when repoPath is set or issue changes
  useEffect(() => {
    if (!repoPath || worktreeInfo) return;
    loadBranches(repoPath);

    // Cleanup timeout on issue change or unmount
    return () => {
      if (pullResultTimeoutRef.current) {
        clearTimeout(pullResultTimeoutRef.current);
        pullResultTimeoutRef.current = null;
      }
    };
  }, [repoPath, worktreeInfo, issueKey]);

  // Create worktree
  const createWorktree = async () => {
    const capturedIssueKey = issueKey; // Capture at start
    const targetBranch = branchMode === "new" ? branchName : selectedExistingBranch;
    if (!repoPath || !targetBranch) return;
    if (branchMode === "new" && !baseBranch) return;

    // Generate unique request ID to handle concurrent operations
    const requestId = (createRequestIds.get(capturedIssueKey) || 0) + 1;
    createRequestIds.set(capturedIssueKey, requestId);

    // Set creating state (issue-specific)
    setIssueTerminalState(capturedIssueKey, { isDeleting: false, isCreating: true });
    setIsDeletingWorktree(false);
    setIsCreatingWorktree(true);
    setWorktreeError(null);

    // Sanitize branch name for folder (replace / with -)
    const folderName = targetBranch.replace(/\//g, "-");

    try {
      const homeDir: string = await invoke("get_home_dir");
      const repoFolderName = repoPath.split("/").pop() || "repo";
      const worktreeDir = `${homeDir}/.jeonghyeon/${repoFolderName}`;
      const worktreePath = `${worktreeDir}/${folderName}`;

      // Check if worktree path already exists
      const exists: boolean = await invoke("check_path_exists", { path: worktreePath });

      // Check if this request is still valid
      if (createRequestIds.get(capturedIssueKey) !== requestId) return;

      // Get default base branch from repo's current branch
      let defaultBaseBranch = "main";
      try {
        const currentBranch = await invoke<string>("run_git_command", {
          cwd: repoPath,
          args: ["rev-parse", "--abbrev-ref", "HEAD"],
        });
        defaultBaseBranch = currentBranch.trim();
      } catch {}

      if (exists) {
        // Path exists, create terminal and run setup.sh
        const info = { path: worktreePath, branch: targetBranch, baseBranch: branchMode === "new" ? baseBranch : defaultBaseBranch, repoPath };
        saveIssueWorktree(projectKey, capturedIssueKey, info);

        const sessionId = await invoke("create_pty_session", { rows: 24, cols: 80, cwd: worktreePath }) as number;

        // Check if this request is still valid after async operation
        if (createRequestIds.get(capturedIssueKey) !== requestId) return;

        const newGroup = { id: 1, terminals: [sessionId], activeTerminal: sessionId, flex: 1 };

        setIssueTerminalState(capturedIssueKey, {
          groups: [newGroup],
          activeGroupId: 1,
          nextGroupId: 2,
          isCreating: false,
          isAutoCreatingTerminal: false,
        });

        await invoke("write_to_pty", { sessionId, data: "./setup.sh\n" }).catch(console.error);

        if (issueKeyRef.current === capturedIssueKey) {
          setWorktreeInfo(info);
          setIsCreatingWorktree(false);
          setGroupsState([newGroup]);
          setActiveGroupIdState(1);
          setNextGroupIdState(2);
          setProjectRepoPaths(getProjectRepoPaths());
        }
        onWorktreeChange?.();
        return;
      }

      // Create directory structure
      await invoke("create_dir_all", { path: worktreeDir });

      // Check if this request is still valid
      if (createRequestIds.get(capturedIssueKey) !== requestId) return;

      if (branchMode === "new") {
        // Create worktree with new branch
        try {
          await invoke("run_git_command", {
            cwd: repoPath,
            args: ["worktree", "add", "-b", targetBranch, worktreePath, baseBranch],
          });
        } catch {
          // Branch might already exist, try without -b flag
          await invoke("run_git_command", {
            cwd: repoPath,
            args: ["worktree", "add", worktreePath, targetBranch],
          });
        }

        // Check if this request is still valid
        if (createRequestIds.get(capturedIssueKey) !== requestId) return;

        const info = { path: worktreePath, branch: targetBranch, baseBranch, repoPath };
        saveIssueWorktree(projectKey, capturedIssueKey, info);

        // Create terminal and run setup.sh immediately (even if on different issue)
        const sessionId = await invoke("create_pty_session", { rows: 24, cols: 80, cwd: worktreePath }) as number;
        const newGroup = { id: 1, terminals: [sessionId], activeTerminal: sessionId, flex: 1 };

        setIssueTerminalState(capturedIssueKey, {
          groups: [newGroup],
          activeGroupId: 1,
          nextGroupId: 2,
          isCreating: false,
          isAutoCreatingTerminal: false,
        });

        // Write setup.sh
        invoke("write_to_pty", { sessionId, data: "./setup.sh\n" }).catch(console.error);

        if (issueKeyRef.current === capturedIssueKey) {
          setWorktreeInfo(info);
          setIsCreatingWorktree(false);
          setGroupsState([newGroup]);
          setActiveGroupIdState(1);
          setNextGroupIdState(2);
          setProjectRepoPaths(getProjectRepoPaths());
        }
        onWorktreeChange?.();
      } else {
        // Use existing local branch
        await invoke("run_git_command", {
          cwd: repoPath,
          args: ["worktree", "add", worktreePath, targetBranch],
        });

        // Check if this request is still valid
        if (createRequestIds.get(capturedIssueKey) !== requestId) return;

        const info = { path: worktreePath, branch: targetBranch, baseBranch: defaultBaseBranch, repoPath };
        saveIssueWorktree(projectKey, capturedIssueKey, info);

        // Create terminal and run setup.sh immediately (even if on different issue)
        const sessionId = await invoke("create_pty_session", { rows: 24, cols: 80, cwd: worktreePath }) as number;
        const newGroup = { id: 1, terminals: [sessionId], activeTerminal: sessionId, flex: 1 };

        setIssueTerminalState(capturedIssueKey, {
          groups: [newGroup],
          activeGroupId: 1,
          nextGroupId: 2,
          isCreating: false,
          isAutoCreatingTerminal: false,
        });

        // Write setup.sh
        invoke("write_to_pty", { sessionId, data: "./setup.sh\n" }).catch(console.error);

        if (issueKeyRef.current === capturedIssueKey) {
          setWorktreeInfo(info);
          setIsCreatingWorktree(false);
          setGroupsState([newGroup]);
          setActiveGroupIdState(1);
          setNextGroupIdState(2);
          setProjectRepoPaths(getProjectRepoPaths());
        }
        onWorktreeChange?.();
      }
    } catch (e: any) {
      // Check if this request is still valid
      if (createRequestIds.get(capturedIssueKey) !== requestId) return;

      console.error("Failed to create worktree:", e);
      setWorktreeError(e?.toString() || "Failed to create worktree");
      setIssueTerminalState(capturedIssueKey, { isCreating: false });
      if (issueKeyRef.current === capturedIssueKey) {
        setIsCreatingWorktree(false);
      }
    }
  };

  // Delete worktree
  const deleteWorktree = async () => {
    const capturedIssueKey = issueKey; // Capture at start
    const capturedWorktreeInfo = worktreeInfo;
    const capturedGroups = groups;
    const capturedRepoPath = repoPath;
    if (!capturedWorktreeInfo || !capturedRepoPath) return;

    // Generate unique request ID to handle concurrent operations
    const requestId = (deleteRequestIds.get(capturedIssueKey) || 0) + 1;
    deleteRequestIds.set(capturedIssueKey, requestId);

    // 1. Set deleting state and hide terminal immediately
    setIssueTerminalState(capturedIssueKey, { isDeleting: true, groups: [], isAutoCreatingTerminal: false });
    setIsDeletingWorktree(true);
    setWorktreeInfo(null);
    setGroupsState([]);
    setShowWorktreePopover(false);
    setConfirmDelete(false);

    try {
      // 2. Clean up terminal cache (synchronous)
      for (const group of capturedGroups) {
        for (const sessionId of group.terminals) {
          const cached = terminalCache.get(sessionId);
          if (cached) {
            cached.cleanup?.();
            cached.term.dispose();
            terminalCache.delete(sessionId);
          }
        }
      }

      // 3. Close PTY sessions
      await Promise.all(
        capturedGroups.flatMap(g => g.terminals).map(id =>
          invoke("close_pty_session", { sessionId: id }).catch(() => {})
        )
      );

      // 4. Delete directory (rm -rf)
      await invoke("delete_directory", { path: capturedWorktreeInfo.path }).catch(() => {});

      // 5. Check if this request is still valid (no newer delete started)
      if (deleteRequestIds.get(capturedIssueKey) !== requestId) {
        return; // Another operation started, cleanup happens in finally
      }

      // 6. Clear state after deletion complete (only if no new worktree was created)
      const currentWorktree = getIssueWorktree(projectKey, capturedIssueKey);
      const newWorktreeCreated = currentWorktree && currentWorktree.path !== capturedWorktreeInfo.path;

      if (!newWorktreeCreated) {
        removeIssueWorktree(projectKey, capturedIssueKey);
      }

      // 7. Git cleanup - must be sequential: prune first, then delete branch
      await invoke("run_git_command", { cwd: capturedRepoPath, args: ["worktree", "prune"] }).catch(() => {});
      await invoke("run_git_command", { cwd: capturedRepoPath, args: ["branch", "-D", capturedWorktreeInfo.branch] }).catch(() => {});
    } finally {
      // Always clear isDeleting flag
      setIssueTerminalState(capturedIssueKey, {
        isDeleting: false,
        isAutoCreatingTerminal: false,
      });

      // Update local state if still on the same issue
      if (issueKeyRef.current === capturedIssueKey) {
        setIsDeletingWorktree(false);
        const currentWorktree = getIssueWorktree(projectKey, capturedIssueKey);
        if (!currentWorktree) {
          setWorktreeInfo(null);
          setGroupsState([]);
          setActiveGroupIdState(null);
          setNextGroupIdState(1);
          setProjectRepoPaths(getProjectRepoPaths());
          setShowWorktreePopover(false);
          setConfirmDelete(false);
          setBranchMode("new");
          setSelectedExistingBranch("");
          setBranchName(capturedIssueKey);
          // Reload branches after worktree deletion
          if (capturedRepoPath) {
            loadBranches(capturedRepoPath);
          }
        }
      }
      onWorktreeChange?.();
    }
  };

  // Get effective terminal path (worktree path)
  const terminalPath = worktreeInfo?.path || null;

  // Sync state with global store
  const setGroups = (updater: TerminalGroup[] | ((prev: TerminalGroup[]) => TerminalGroup[])) => {
    setGroupsState(prev => {
      const newVal = typeof updater === 'function' ? updater(prev) : updater;
      setIssueTerminalState(issueKey, { groups: newVal });
      return newVal;
    });
  };
  const setActiveGroupId = (id: number | null) => {
    setActiveGroupIdState(id);
    setIssueTerminalState(issueKey, { activeGroupId: id });
  };
  const setTerminalHeight = (h: number) => {
    setTerminalHeightState(h);
    setIssueTerminalState(issueKey, { terminalHeight: h });
  };

  // Reload state when issueKey changes
  useEffect(() => {
    const state = getIssueTerminalState(issueKey);
    setGroupsState(state.groups);
    setActiveGroupIdState(state.activeGroupId);
    setNextGroupIdState(state.nextGroupId);
    setTerminalHeightState(state.terminalHeight);
    // If creating/deleting, show null worktreeInfo to display indicator
    const isInProgress = state.isDeleting || state.isCreating;
    const wt = getIssueWorktree(projectKey, issueKey);
    setWorktreeInfo(isInProgress ? null : wt);
    setRepoPath(wt?.repoPath || null);
    setWorktreeError(null);
    setIsCreatingWorktree(state.isCreating || false);
    setIsDeletingWorktree(state.isDeleting || false);
    setConfirmDelete(false);
    setBranchMode("new");
    setSelectedExistingBranch("");
    setBranchName(issueKey);
    setPrList([]);
    setProjectRepoPaths(getProjectRepoPaths());
  }, [issueKey, projectKey]);

  // Check for open PR when worktree is set
  useEffect(() => {
    if (!worktreeInfo || !repoPath) {
      currentPrCheckRef.current = null;
      setPrList([]);
      return;
    }

    const currentCheck = { branch: worktreeInfo.branch, repoPath };
    currentPrCheckRef.current = currentCheck;

    const checkPr = () => {
      // Double defer to completely isolate from React's event loop
      setTimeout(() => {
        if (currentPrCheckRef.current !== currentCheck) return;
        Promise.all([
          invoke("run_gh_command", {
            cwd: repoPath,
            args: ["pr", "list", "--head", worktreeInfo.branch, "--json", "url,state,isDraft,number,headRefName,baseRefName,reviewDecision", "--limit", "20"]
          }),
          invoke("run_gh_command", {
            cwd: repoPath,
            args: ["pr", "list", "--head", worktreeInfo.branch, "--state", "closed", "--json", "url,state,isDraft,number,headRefName,baseRefName,reviewDecision", "--limit", "20"]
          })
        ]).then(([openResult, closedResult]: unknown[]) => {
          if (currentPrCheckRef.current !== currentCheck) return;
          const openData = JSON.parse(openResult as string);
          const closedData = JSON.parse(closedResult as string);
          const allPrs = [...openData, ...closedData];
          // Deduplicate by number
          const seen = new Set<number>();
          const unique = allPrs.filter((pr: { number: number }) => {
            if (seen.has(pr.number)) return false;
            seen.add(pr.number);
            return true;
          });
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const mapped = unique.map((pr: any) => ({ ...pr, reviewDecision: pr.reviewDecision || '' }));
          const stateOrder = (pr: any) => {
            if (pr.state === 'CLOSED') return 0;
            if (pr.state === 'MERGED') return 1;
            if (pr.isDraft) return 2;
            return 3; // open
          };
          setPrList(mapped.sort((a: any, b: any) => stateOrder(a) - stateOrder(b) || a.number - b.number));
        }).catch(() => {
          if (currentPrCheckRef.current !== currentCheck) return;
          setPrList([]);
        });
      }, 0);
    };

    checkPr();
    const interval = setInterval(checkPr, 60000);
    return () => {
      clearInterval(interval);
    };
  }, [worktreeInfo, repoPath]);

  // Auto-create terminal when worktree is ready and no terminals exist
  useEffect(() => {
    // Capture issueKey at the start of this effect
    const capturedIssueKey = issueKey;

    // Get the correct worktree for THIS issue (not from stale state)
    const currentWorktree = getIssueWorktree(projectKey, capturedIssueKey);
    const currentTerminalPath = currentWorktree?.path || null;
    if (!currentTerminalPath) return;
    const state = getIssueTerminalState(capturedIssueKey);
    // Skip if already creating terminal or terminals exist
    if (state.groups.length > 0 || state.isAutoCreatingTerminal) return;

    const groupId = state.nextGroupId;

    // Set flag SYNCHRONOUSLY to prevent duplicate creation
    setIssueTerminalState(capturedIssueKey, {
      isAutoCreatingTerminal: true,
    });

    // Create PTY and handle setup.sh
    (async () => {
      try {
        const sessionId = await invoke("create_pty_session", { rows: 24, cols: 80, cwd: currentTerminalPath }) as number;
        const newGroup = { id: groupId, terminals: [sessionId], activeTerminal: sessionId, flex: 1 };

        // Save to global state for the captured issue
        setIssueTerminalState(capturedIssueKey, {
          groups: [newGroup],
          activeGroupId: groupId,
          nextGroupId: groupId + 1,
          isAutoCreatingTerminal: false,
        });

        // Only update local state if still on the same issue
        if (issueKeyRef.current === capturedIssueKey) {
          setGroupsState([newGroup]);
          setActiveGroupIdState(groupId);
          setNextGroupIdState(groupId + 1);
        }

        // setup.sh is now run in createWorktree, not here
      } catch (e) {
        console.error("Failed to create PTY:", e);
        // Clear flag on error
        setIssueTerminalState(capturedIssueKey, { isAutoCreatingTerminal: false });
      }
    })();
  }, [issueKey, projectKey, terminalPath]);

  const createNewGroup = async () => {
    // Capture issueKey at the start of this function
    const capturedIssueKey = issueKey;

    const currentWorktree = getIssueWorktree(projectKey, capturedIssueKey);
    const cwd = currentWorktree?.path;
    if (!cwd) return;
    const groupId = nextGroupId;

    // Optimistically update nextGroupId
    const currentState = getIssueTerminalState(capturedIssueKey);
    setIssueTerminalState(capturedIssueKey, { nextGroupId: groupId + 1 });
    if (issueKeyRef.current === capturedIssueKey) {
      setNextGroupIdState(groupId + 1);
    }

    try {
      const sessionId: number = await invoke("create_pty_session", { rows: 24, cols: 80, cwd });
      const newGroup = { id: groupId, terminals: [sessionId], activeTerminal: sessionId, flex: 1 };

      // Always save to global state for the captured issue
      setIssueTerminalState(capturedIssueKey, {
        groups: [...currentState.groups, newGroup],
        activeGroupId: groupId,
      });

      // Only update local state if still on the same issue
      if (issueKeyRef.current === capturedIssueKey) {
        setGroupsState(prev => [...prev, newGroup]);
        setActiveGroupIdState(groupId);
      }
    } catch (e) {
      console.error("Failed to create PTY:", e);
    }
  };

  const addTerminalToGroup = async (targetGroupId: number) => {
    // Capture issueKey at the start of this function
    const capturedIssueKey = issueKey;

    const currentWorktree = getIssueWorktree(projectKey, capturedIssueKey);
    const cwd = currentWorktree?.path;
    if (!cwd) return;
    try {
      const sessionId: number = await invoke("create_pty_session", { rows: 24, cols: 80, cwd });

      // Always save to global state for the captured issue
      const currentState = getIssueTerminalState(capturedIssueKey);
      const updatedGroups = currentState.groups.map(g =>
        g.id === targetGroupId ? { ...g, terminals: [...g.terminals, sessionId], activeTerminal: sessionId } : g
      );
      setIssueTerminalState(capturedIssueKey, { groups: updatedGroups });

      // Only update local state if still on the same issue
      if (issueKeyRef.current === capturedIssueKey) {
        setGroupsState(updatedGroups);
      }
    } catch (e) {
      console.error("Failed to create PTY:", e);
    }
  };

  const closeTerminal = async (groupId: number, sessionId: number) => {
    // Count total terminals across all groups
    const totalTerminals = groups.reduce((sum, g) => sum + g.terminals.length, 0);
    const isLastTerminal = totalTerminals <= 1;

    // Clean up terminal cache
    const cached = terminalCache.get(sessionId);
    if (cached) {
      cached.cleanup?.();
      cached.term.dispose();
      terminalCache.delete(sessionId);
    }
    try { await invoke("close_pty_session", { sessionId }); } catch {}

    if (isLastTerminal) {
      // Create a new group with a new terminal
      await createNewGroup();
      setGroups(prev => prev.filter(g => g.id !== groupId));
    } else {
      setGroups(prev => {
        return prev.map(g => {
          if (g.id !== groupId) return g;
          const newTerminals = g.terminals.filter(t => t !== sessionId);
          const newActive = g.activeTerminal === sessionId
            ? (newTerminals[newTerminals.length - 1] ?? null)
            : g.activeTerminal;
          return { ...g, terminals: newTerminals, activeTerminal: newActive };
        }).filter(g => g.terminals.length > 0);
      });
    }
  };

  const closeGroup = async (groupId: number) => {
    const isLastGroup = groups.length <= 1;

    const group = groups.find(g => g.id === groupId);
    if (group) {
      for (const sessionId of group.terminals) {
        // Clean up terminal cache
        const cached = terminalCache.get(sessionId);
        if (cached) {
          cached.cleanup?.();
          cached.term.dispose();
          terminalCache.delete(sessionId);
        }
        try { await invoke("close_pty_session", { sessionId }); } catch {}
      }
    }

    if (isLastGroup) {
      // Create a new group first, then remove the old one
      await createNewGroup();
    }
    setGroups(prev => prev.filter(g => g.id !== groupId));
  };

  // No cleanup on issueKey change - terminals persist per issue

  const handleResizeStart = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    if (isMaximized) return;

    const onMove = (ev: PointerEvent) => {
      const h = window.innerHeight - ev.clientY - 22;
      const clamped = Math.max(150, Math.min(h, window.innerHeight - 91));
      setTerminalHeight(clamped);
    };
    const onUp = () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.removeEventListener("pointercancel", onUp);
    };
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
    document.addEventListener("pointercancel", onUp);
  }, [isMaximized]);

  // Group width resize handler
  const handleGroupResizeStart = useCallback((index: number) => (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setResizingGroupIndex(index);
  }, []);

  useEffect(() => {
    if (resizingGroupIndex === null) return;
    const container = groupsContainerRef.current;
    if (!container) return;

    const onMove = (e: MouseEvent) => {
      const containerRect = container.getBoundingClientRect();
      const containerWidth = containerRect.width;
      const mouseX = e.clientX - containerRect.left;

      // Calculate cumulative width up to resize handle
      let totalFlex = 0;
      groups.forEach(g => totalFlex += g.flex);

      // Calculate new flex values for the two groups being resized
      const leftGroup = groups[resizingGroupIndex];
      const rightGroup = groups[resizingGroupIndex + 1];
      if (!leftGroup || !rightGroup) return;

      // Calculate position as percentage
      let leftWidth = 0;
      for (let i = 0; i < resizingGroupIndex; i++) {
        leftWidth += (groups[i].flex / totalFlex) * containerWidth;
      }

      const combinedFlex = leftGroup.flex + rightGroup.flex;
      const combinedWidth = (combinedFlex / totalFlex) * containerWidth;
      const newLeftWidth = mouseX - leftWidth;
      const newRightWidth = combinedWidth - newLeftWidth;

      // Minimum width constraint (50px)
      if (newLeftWidth < 50 || newRightWidth < 50) return;

      const newLeftFlex = (newLeftWidth / combinedWidth) * combinedFlex;
      const newRightFlex = combinedFlex - newLeftFlex;

      setGroups(prev => prev.map((g, i) => {
        if (i === resizingGroupIndex) return { ...g, flex: newLeftFlex };
        if (i === resizingGroupIndex + 1) return { ...g, flex: newRightFlex };
        return g;
      }));
    };

    const onUp = () => setResizingGroupIndex(null);
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    return () => { document.removeEventListener("mousemove", onMove); document.removeEventListener("mouseup", onUp); };
  }, [resizingGroupIndex, groups]);

  // Terminal keyboard shortcuts
  useEffect(() => {
    const shortcuts = getShortcuts();
    const handleKeyDown = (e: KeyboardEvent) => {
      if (matchesShortcut(e, shortcuts.newTerminalGroup)) {
        e.preventDefault();
        if (terminalPath) createNewGroup();
      } else if (matchesShortcut(e, shortcuts.newTerminalTab)) {
        e.preventDefault();
        e.stopPropagation();
        if (terminalPath && activeGroupId !== null) addTerminalToGroup(activeGroupId);
      } else if (matchesShortcut(e, shortcuts.prevTerminalTab)) {
        e.preventDefault();
        if (activeGroupId !== null) {
          setGroups(prev => prev.map(g => {
            if (g.id !== activeGroupId || g.terminals.length <= 1) return g;
            const idx = g.terminals.indexOf(g.activeTerminal!);
            const newIdx = idx <= 0 ? g.terminals.length - 1 : idx - 1;
            return { ...g, activeTerminal: g.terminals[newIdx] };
          }));
        }
      } else if (matchesShortcut(e, shortcuts.nextTerminalTab)) {
        e.preventDefault();
        if (activeGroupId !== null) {
          setGroups(prev => prev.map(g => {
            if (g.id !== activeGroupId || g.terminals.length <= 1) return g;
            const idx = g.terminals.indexOf(g.activeTerminal!);
            const newIdx = idx >= g.terminals.length - 1 ? 0 : idx + 1;
            return { ...g, activeTerminal: g.terminals[newIdx] };
          }));
        }
      } else if (matchesShortcut(e, shortcuts.closeTerminalTab)) {
        // Always prevent default to avoid closing the window
        e.preventDefault();
        // Only close terminal if focus is within terminal panel
        const terminalPanel = document.querySelector('.terminal-panel');
        if (terminalPanel?.contains(document.activeElement) || document.activeElement?.closest('.terminal-panel')) {
          if (activeGroupId !== null) {
            const group = groups.find(g => g.id === activeGroupId);
            if (group?.activeTerminal != null) {
              closeTerminal(activeGroupId, group.activeTerminal);
            }
          }
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [terminalPath, activeGroupId, groups]);

  // Show worktree setup UI if no worktree exists
  if (!worktreeInfo) {
    return (
      <div className={`terminal-panel ${isMaximized && !isCollapsed ? "maximized" : ""} ${isMaximized && !isCollapsed ? "no-worktree" : ""}`} style={{ height: isCollapsed ? 32 : isMaximized ? "100%" : terminalHeight }}>
        {!isCollapsed && !isMaximized && <div className="terminal-resize-handle" onPointerDown={handleResizeStart} />}
        <div className="terminal-header">
          <span className="terminal-header-title">TERMINAL</span>
          <div className="terminal-header-actions">
            <button className="terminal-header-btn" onClick={() => { if (isCollapsed) { setIsCollapsed(false); setIsMaximized(true); } else { setIsMaximized(!isMaximized); } }} title={isMaximized && !isCollapsed ? "Restore" : "Maximize"}>
              {isMaximized && !isCollapsed ? <MinimizeIcon /> : <MaximizeIcon />}
            </button>
            <button className="terminal-header-btn" onClick={() => setIsCollapsed(!isCollapsed)}>
              <ChevronIcon open={!isCollapsed} />
            </button>
          </div>
        </div>
        {!isCollapsed && (
          <div className={`terminal-worktree-setup ${isMaximized ? 'maximized' : ''}`}>
            {isDeletingWorktree ? (
              <div className="terminal-worktree-loading">
                <div className="terminal-worktree-spinner" />
                <div className="terminal-worktree-loading-text">Deleting worktree...</div>
              </div>
            ) : isCreatingWorktree ? (
              <div className="terminal-worktree-loading">
                <div className="terminal-worktree-spinner" />
                <div className="terminal-worktree-loading-text">Setting up worktree...</div>
              </div>
            ) : !repoPath ? (
              <>
                <div className="terminal-connect-icon">
                  <svg className="icon-3xl" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                    <path d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
                  </svg>
                </div>
                <div className="terminal-connect-text">
                  <div className="terminal-connect-title">Setup Worktree</div>
                  <div className="terminal-connect-desc">Select repository folder and create an isolated worktree for this issue</div>
                </div>
                <div className="terminal-worktree-form">
                  <div className="terminal-worktree-field">
                    <label>Repository Folder</label>
                    <button className="terminal-repo-select-btn" onClick={selectRepository} disabled={pullingBranch !== null || isCreatingWorktree}>
                      <svg className="icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
                      </svg>
                      Select Folder
                    </button>
                    {projectRepoPaths.length > 0 && (
                      <div className="terminal-repo-list">
                        <div className="terminal-repo-list-label">Recently used</div>
                        {projectRepoPaths.map((path) => (
                          <button
                            key={path}
                            className="terminal-repo-list-item"
                            onClick={() => setRepoPath(path)}
                            title={path}
                            disabled={pullingBranch !== null || isCreatingWorktree}
                          >
                            <svg className="icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                              <path d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
                            </svg>
                            <span className="terminal-repo-list-item-path">{path.split("/").pop() || path}</span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </>
            ) : branches.length === 0 ? (
              <div className="terminal-worktree-loading">
                <div className="terminal-worktree-spinner" />
                <div className="terminal-worktree-loading-text">Loading branches...</div>
              </div>
            ) : (
              <>
                <div className="terminal-connect-icon">
                  <svg className="icon-3xl" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                    <path d="M6 3v12" />
                    <circle cx="18" cy="6" r="3" />
                    <circle cx="6" cy="18" r="3" />
                    <path d="M18 9a9 9 0 01-9 9" />
                  </svg>
                </div>
                <div className="terminal-connect-text">
                  <div className="terminal-connect-title">Setup Worktree</div>
                  <div className="terminal-connect-desc">Create an isolated worktree for this issue</div>
                </div>
                <div className="terminal-worktree-form">
                  <div className="terminal-worktree-field">
                    <label>Repository</label>
                    <div className={`terminal-repo-display ${pullingBranch !== null || isCreatingWorktree ? 'disabled' : ''}`}>
                      <span className="terminal-repo-path">{repoPath}</span>
                      <button className="terminal-repo-clear-btn" onClick={() => { setRepoPath(null); setBranches([]); }} title="Clear repository" disabled={pullingBranch !== null || isCreatingWorktree}>
                        <svg className="icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <path d="M18 6L6 18M6 6l12 12" />
                        </svg>
                      </button>
                    </div>
                  </div>
                  {branchMode === "new" && (
                    <div className="terminal-worktree-field">
                      <label>Base Branch</label>
                      <div className="terminal-branch-select-with-pull" style={{ position: 'relative' }}>
                        {pullResult && lastPulledBranch === baseBranch && (
                          <div className="terminal-worktree-success">{pullResult}</div>
                        )}
                        <select value={baseBranch} onChange={(e) => setBaseBranch(e.target.value)} disabled={pullingBranch !== null || isCreatingWorktree}>
                          {branches.map(b => (
                            <option key={b} value={b}>{b}{b === currentBranch ? " (current)" : ""}</option>
                          ))}
                        </select>
                        <button
                          className="terminal-branch-pull-btn"
                          onClick={() => pullBranch(baseBranch)}
                          disabled={!baseBranch || pullingBranch !== null || isCreatingWorktree}
                          title="Pull latest changes"
                        >
                          {pullingBranch === baseBranch ? (
                            <svg className={`icon-sm spinning`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                              <path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8" />
                              <path d="M21 3v5h-5" />
                            </svg>
                          ) : (
                            <svg className={`icon-sm`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                              <line x1="12" y1="5" x2="12" y2="19" />
                              <polyline points="19 12 12 19 5 12" />
                            </svg>
                          )}
                        </button>
                      </div>
                    </div>
                  )}
                  <div className="terminal-worktree-field">
                    <label>Branch</label>
                    <div className="terminal-worktree-branch-input" style={{ position: 'relative' }}>
                      {pullResult && branchMode === "existing" && lastPulledBranch === selectedExistingBranch && (
                        <div className="terminal-worktree-success">{pullResult}</div>
                      )}
                      {branchMode === "new" ? (
                        <input
                          type="text"
                          value={branchName}
                          onChange={(e) => setBranchName(e.target.value)}
                          placeholder={issueKey}
                          className={branchNameError ? "input-error" : ""}
                          disabled={pullingBranch !== null || isCreatingWorktree}
                        />
                      ) : (
                        <>
                          <select
                            value={selectedExistingBranch}
                            onChange={(e) => setSelectedExistingBranch(e.target.value)}
                            disabled={pullingBranch !== null || isCreatingWorktree}
                          >
                            <option value="" disabled>Select branch...</option>
                            {(() => {
                              const usedBranches = getUsedBranches();
                              return branches.map(b => {
                                const isUsed = usedBranches.has(b);
                                const isCurrent = b === currentBranch;
                                return (
                                  <option key={b} value={b} disabled={isUsed || isCurrent}>
                                    {b}{isCurrent ? " (current)" : ""}{isUsed ? " (in use)" : ""}
                                  </option>
                                );
                              });
                            })()}
                          </select>
                          <button
                            className="terminal-branch-pull-btn"
                            onClick={() => pullBranch(selectedExistingBranch)}
                            disabled={!selectedExistingBranch || pullingBranch !== null || isCreatingWorktree}
                            title="Pull latest changes"
                          >
                            {pullingBranch === selectedExistingBranch ? (
                              <svg className={`icon-sm spinning`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                <path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8" />
                                <path d="M21 3v5h-5" />
                              </svg>
                            ) : (
                              <svg className={`icon-sm`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <line x1="12" y1="5" x2="12" y2="19" />
                                <polyline points="19 12 12 19 5 12" />
                              </svg>
                            )}
                          </button>
                        </>
                      )}
                      <button
                        className="terminal-worktree-mode-btn"
                        onClick={() => setBranchMode(branchMode === "new" ? "existing" : "new")}
                        title={branchMode === "new" ? "Use existing branch" : "Create new branch"}
                        disabled={pullingBranch !== null || isCreatingWorktree}
                      >
                        {branchMode === "new" ? (
                          <svg className="icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" />
                          </svg>
                        ) : (
                          <svg className="icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <path d="M12 5v14M5 12h14" />
                          </svg>
                        )}
                      </button>
                    </div>
                    <span className="terminal-worktree-mode-hint">
                      {branchMode === "new" ? "Creating new branch" : "Using existing branch"}
                    </span>
                  </div>
                  {worktreeError && (
                    <div className="terminal-worktree-error">{worktreeError}</div>
                  )}
                  {branchMode === "existing" && selectedExistingBranch && (
                    <>
                      {selectedExistingBranch === currentBranch ? (
                        <div className="terminal-worktree-error">Cannot use current branch</div>
                      ) : getUsedBranches().has(selectedExistingBranch) ? (
                        <div className="terminal-worktree-error">This branch is in use by another issue</div>
                      ) : null}
                    </>
                  )}
                  <button
                    className="terminal-connect-btn"
                    onClick={createWorktree}
                    disabled={pullingBranch !== null || (branchMode === "new" ? (!branchName || !baseBranch || !!branchNameError) : (!selectedExistingBranch || selectedExistingBranch === currentBranch || getUsedBranches().has(selectedExistingBranch)))}
                  >
                    Create Worktree
                  </button>
                </div>
                <div className="terminal-worktree-path-preview">
                  <span>~/.jeonghyeon/{repoPath?.split("/").pop()}/{(() => {
                    const target = branchMode === "new" ? branchName : selectedExistingBranch;
                    let displayName = target || "branch-name";
                    if (displayName.startsWith("remotes/")) {
                      displayName = displayName.split("/").slice(2).join("/");
                    }
                    return displayName.replace(/\//g, "-");
                  })()}</span>
                </div>
              </>
            )}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className={`terminal-panel ${isMaximized && !isCollapsed ? "maximized" : ""}`} style={{ height: isCollapsed ? 32 : isMaximized ? "100%" : terminalHeight }}>
      {!isCollapsed && !isMaximized && <div className="terminal-resize-handle" onPointerDown={handleResizeStart} />}
      <div className="terminal-header">
        <div className="terminal-header-left">
          <span className="terminal-header-title">TERMINAL</span>
          {worktreeInfo && (
            <div className="terminal-branch-wrapper">
              <button
                className="terminal-repo-action-btn"
                onClick={async () => {
                  if (!worktreeInfo?.path) return;
                  try {
                    await invoke("open_in_zed", { path: worktreeInfo.path });
                  } catch (error) {
                    console.error("Failed to open Zed:", error);
                  }
                }}
                title="Open worktree in Zed"
              >
                <svg className="icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
                </svg>
              </button>
              <button
                className="terminal-branch-badge"
                onClick={() => {
                  if (isCollapsed) setIsCollapsed(false);
                  setShowWorktreePopover(!showWorktreePopover);
                }}
              >
                <svg className="icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M6 3v12" /><circle cx="18" cy="6" r="3" /><circle cx="6" cy="18" r="3" /><path d="M18 9a9 9 0 01-9 9" />
                </svg>
                {worktreeInfo.branch}
              </button>
              {showWorktreePopover && (
                <>
                  <div className="terminal-popover-backdrop" onClick={() => { setShowWorktreePopover(false); setConfirmDelete(false); }} />
                  <div className="terminal-worktree-popover">
                    {confirmDelete ? (
                      <>
                        <div className="terminal-popover-header">Delete Worktree?</div>
                        <div className="terminal-popover-confirm-msg">
                          This will remove the worktree directory and all local changes.
                        </div>
                        <div className="terminal-popover-actions">
                          <button
                            className="terminal-popover-cancel"
                            onClick={() => setConfirmDelete(false)}
                          >
                            Cancel
                          </button>
                          <button
                            className="terminal-popover-confirm"
                            onClick={deleteWorktree}
                          >
                            Delete
                          </button>
                        </div>
                      </>
                    ) : (
                      <>
                        <div className="terminal-popover-header">Worktree</div>
                        <div className="terminal-popover-info">
                          <div className="terminal-popover-row">
                            <span className="terminal-popover-label">Branch</span>
                            <div className="terminal-popover-path-row">
                              <span className="terminal-popover-value terminal-popover-path">{worktreeInfo.branch}</span>
                              <button className={`terminal-popover-copy ${branchCopied ? 'copied' : ''}`} onClick={() => { navigator.clipboard.writeText(worktreeInfo.branch); setBranchCopied(true); setTimeout(() => setBranchCopied(false), 1500); }} title="Copy branch">
                                {branchCopied ? <CheckIcon /> : <CopyIcon />}
                              </button>
                            </div>
                          </div>
                          <div className="terminal-popover-row">
                            <span className="terminal-popover-label">Path</span>
                            <div className="terminal-popover-path-row">
                              <span className="terminal-popover-value terminal-popover-path">{worktreeInfo.path}</span>
                              <button className={`terminal-popover-copy ${pathCopied ? 'copied' : ''}`} onClick={() => { navigator.clipboard.writeText(worktreeInfo.path); setPathCopied(true); setTimeout(() => setPathCopied(false), 1500); }} title="Copy path">
                                {pathCopied ? <CheckIcon /> : <CopyIcon />}
                              </button>
                            </div>
                          </div>
                        </div>
                        <button
                          className="terminal-popover-delete"
                          onClick={() => setConfirmDelete(true)}
                        >
                          Delete Worktree
                        </button>
                      </>
                    )}
                  </div>
                </>
              )}
            </div>
          )}
          {prList.map((pr) => (
            <div key={pr.number} className="terminal-pr-badge-wrapper">
              <button
                className={`terminal-pr-badge ${pr.isDraft ? 'draft' : pr.state === 'OPEN' ? 'open' : pr.state === 'MERGED' ? 'merged' : 'closed'}`}
                onClick={() => openUrl(pr.url)}
              >
                <svg className="icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="18" cy="18" r="3" /><circle cx="6" cy="6" r="3" /><path d="M6 9v6c0 1.1.9 2 2 2h3" /><path d="M18 9v6" />
                </svg>
                {pr.isDraft ? 'Draft' : 'PR'} #{pr.number}
                {pr.reviewDecision && (pr.state === 'OPEN' || pr.isDraft) && (
                  <span className={`terminal-pr-review ${pr.reviewDecision === 'APPROVED' ? 'approved' : pr.reviewDecision === 'CHANGES_REQUESTED' ? 'changes' : 'pending'}`}>
                    {pr.reviewDecision === 'APPROVED' ? (
                      <svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="20 6 9 17 4 12" /></svg>
                    ) : pr.reviewDecision === 'CHANGES_REQUESTED' ? (
                      <svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" /><path d="M18.5 2.5a2.12 2.12 0 013 3L12 15l-4 1 1-4 9.5-9.5z" /></svg>
                    ) : (
                      <svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" /><circle cx="12" cy="12" r="3" /></svg>
                    )}
                  </span>
                )}
              </button>
              <div className="terminal-pr-tooltip">
                <span className="terminal-pr-tooltip-branch">{pr.headRefName}</span>
                <span className="terminal-pr-tooltip-arrow">→</span>
                <span className="terminal-pr-tooltip-branch">{pr.baseRefName}</span>
                <span className={`terminal-pr-tooltip-state ${pr.isDraft ? 'draft' : pr.state === 'OPEN' ? 'open' : pr.state === 'MERGED' ? 'merged' : 'closed'}`}>
                  {pr.isDraft ? 'Draft' : pr.state === 'OPEN' ? 'Open' : pr.state === 'MERGED' ? 'Merged' : 'Closed'}
                </span>
              </div>
            </div>
          ))}
        </div>
        <div className="terminal-header-actions">
          <button className="terminal-header-btn" onClick={createNewGroup} title="Split"><SplitIcon /></button>
          <button className="terminal-header-btn" onClick={() => { if (isCollapsed) { setIsCollapsed(false); setIsMaximized(true); } else { setIsMaximized(!isMaximized); } }} title={isMaximized && !isCollapsed ? "Restore" : "Maximize"}>
            {isMaximized && !isCollapsed ? <MinimizeIcon /> : <MaximizeIcon />}
          </button>
          <button className="terminal-header-btn" onClick={() => setIsCollapsed(!isCollapsed)}>
            <ChevronIcon open={!isCollapsed} />
          </button>
        </div>
      </div>
      <div className="terminal-body" style={{ display: isCollapsed ? 'none' : 'flex' }}>
        <div className="terminal-groups" ref={groupsContainerRef}>
          {groups.map((g, index) => (
            <Fragment key={g.id}>
              <TerminalGroupView
                group={g}
                isActive={activeGroupId === g.id}
                onActivate={() => setActiveGroupId(g.id)}
                onAddTerminal={() => addTerminalToGroup(g.id)}
                onCloseTerminal={(id) => closeTerminal(g.id, id)}
                onSelectTerminal={(id) => setGroups(prev => prev.map(gr => gr.id === g.id ? { ...gr, activeTerminal: id } : gr))}
                onCloseGroup={() => closeGroup(g.id)}
                fontSize={terminalFontSize}
              />
              {index < groups.length - 1 && (
                <div
                  className={`terminal-group-resize-handle ${resizingGroupIndex === index ? 'active' : ''}`}
                  onMouseDown={handleGroupResizeStart(index)}
                />
              )}
            </Fragment>
          ))}
        </div>
      </div>
    </div>
  );
}

function IssueDetailView({ issueKey, onIssueClick, onCreateChild, onRefresh, refreshTrigger, terminalCollapsed, setTerminalCollapsed, terminalMaximized, setTerminalMaximized, renderTerminal = true }: { issueKey: string; onIssueClick: (key: string) => void; onCreateChild: (projectKey: string, parentKey: string) => void; onRefresh: () => void; refreshTrigger: number; terminalCollapsed: boolean; setTerminalCollapsed: (v: boolean) => void; terminalMaximized: boolean; setTerminalMaximized: (v: boolean) => void; renderTerminal?: boolean }) {
  const [showTerminal, _setShowTerminal] = useState(true);
  const issueKeyRef = useRef(issueKey);
  issueKeyRef.current = issueKey;
  const [issue, setIssue] = useState<IssueDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Edit options
  const [transitions, setTransitions] = useState<{ id: string; name: string }[]>([]);
  const [users, setUsers] = useState<{ accountId: string; displayName: string }[]>([]);
  const [priorities, setPriorities] = useState<{ id: string; name: string }[]>([]);
  const [projectIssueTypes, setProjectIssueTypes] = useState<{ id: string; name: string }[]>([]);
  const [editValue, setEditValue] = useState("");
  const [newComment, setNewComment] = useState("");
  const [addingComment, setAddingComment] = useState(false);
  const [editingComment, setEditingComment] = useState<string | null>(null);
  const [editCommentValue, setEditCommentValue] = useState("");
  const [_replyTo, setReplyTo] = useState<{ author: string } | null>(null);
  const [copiedKey, setCopiedKey] = useState(false);
  const [copiedUrl, setCopiedUrl] = useState(false);

  // Labels and components editing
  const [availableLabels, setAvailableLabels] = useState<string[]>([]);
  const [selectedLabels, setSelectedLabels] = useState<string[]>([]);
  const [labelsLoading, setLabelsLoading] = useState(false);
  const [projectComponents, setProjectComponents] = useState<{ id: string; name: string }[]>([]);
  const [selectedComponents, setSelectedComponents] = useState<string[]>([]);
  const [componentsLoading, setComponentsLoading] = useState(false);

  // Time tracking states
  const [showLogWork, setShowLogWork] = useState(false);
  const [logTimeSpent, setLogTimeSpent] = useState("");
  const [logComment, setLogComment] = useState("");
  const [editingWorklog, setEditingWorklog] = useState<string | null>(null);
  const [editWorklogField, setEditWorklogField] = useState<"time" | "comment">("time");
  const [editWorklogTime, setEditWorklogTime] = useState("");
  const [editWorklogComment, setEditWorklogComment] = useState("");
  const [estimateValue, setEstimateValue] = useState("");
  const [remainingValue, setRemainingValue] = useState("");
  const [timeSaving, setTimeSaving] = useState(false);
  const [deletingWorklogs, setDeletingWorklogs] = useState<Set<string>>(new Set());
  const [worklogCountBeforeSave, setWorklogCountBeforeSave] = useState<number | null>(null);

  // 워크로그가 추가되면 입력창 닫기
  useEffect(() => {
    if (issue && worklogCountBeforeSave !== null && issue.worklogs.length > worklogCountBeforeSave) {
      setLogTimeSpent("");
      setLogComment("");
      setShowLogWork(false);
      setTimeSaving(false);
      setWorklogCountBeforeSave(null);
    }
  }, [issue?.worklogs.length, worklogCountBeforeSave]);

  // 워크로그가 삭제되면 deletingWorklogs에서 없어진 ID 제거
  const worklogIds = issue?.worklogs.map(w => w.id).join(",") || "";
  useEffect(() => {
    if (issue && deletingWorklogs.size > 0) {
      const currentIds = new Set(issue.worklogs.map(w => w.id));
      const stillDeleting = new Set([...deletingWorklogs].filter(id => currentIds.has(id)));
      if (stillDeleting.size !== deletingWorklogs.size) {
        setDeletingWorklogs(stillDeleting);
      }
    }
  }, [worklogIds, deletingWorklogs]);

  const copyToClipboard = async (text: string, type: "key" | "url") => {
    try {
      await navigator.clipboard.writeText(text);
      if (type === "key") {
        setCopiedKey(true);
        setTimeout(() => setCopiedKey(false), 800);
      } else {
        setCopiedUrl(true);
        setTimeout(() => setCopiedUrl(false), 800);
      }
    } catch (e) {
      console.error("Failed to copy:", e);
    }
  };

  const reload = () => {
    const capturedKey = issueKey;
    fetchIssueDetail(capturedKey).then((data) => {
      if (issueKeyRef.current === capturedKey) setIssue(data);
    }).catch(console.error);
  };

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setEditing(null);
    setEditValue("");
    setSaving(false);
    // Reset worklog states
    setShowLogWork(false);
    setLogTimeSpent("");
    setLogComment("");
    setEditingWorklog(null);
    setTimeSaving(false);
    setDeletingWorklogs(new Set());
    setWorklogCountBeforeSave(null);
    fetchIssueDetail(issueKey)
      .then((data) => {
        if (!cancelled) setIssue(data);
      })
      .catch((e) => {
        if (!cancelled) setError(e.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [issueKey]);

  // Auto refresh (no loading state)
  useEffect(() => {
    if (refreshTrigger > 0) {
      const capturedKey = issueKey;
      fetchIssueDetail(capturedKey).then((data) => {
        if (issueKeyRef.current === capturedKey) setIssue(data);
      }).catch(console.error);
    }
  }, [refreshTrigger, issueKey]);

  const startEdit = async (field: string) => {
    if (!issue) return;
    setEditing(field);

    if (field === "status") {
      const t = await fetchTransitions(issueKey);
      setTransitions(t);
    } else if (field === "assignee" || field === "reporter") {
      const u = await fetchAssignableUsers(issue.projectKey);
      setUsers(u);
    } else if (field === "priority") {
      const p = await fetchPriorities();
      setPriorities(p);
    } else if (field === "summary") {
      setEditValue(issue.summary);
    } else if (field === "description") {
      setEditValue(issue.description);
    } else if (field === "labels") {
      setLabelsLoading(true);
      const [labels, latestIssue] = await Promise.all([
        fetchLabels(),
        fetchIssueDetail(issueKey)
      ]);
      setAvailableLabels(labels);
      setSelectedLabels(latestIssue.labels);
      setLabelsLoading(false);
    } else if (field === "components") {
      setComponentsLoading(true);
      const [comps, latestIssue] = await Promise.all([
        fetchProjectComponents(issue.projectKey),
        fetchIssueDetail(issueKey)
      ]);
      setProjectComponents(comps);
      setSelectedComponents(latestIssue.components);
      setComponentsLoading(false);
    } else if (field === "issueType") {
      const types = await fetchProjectIssueTypesWithId(issue.projectKey);
      setProjectIssueTypes(types);
    }
  };

  const saveEdit = async (field: string, value: any) => {
    if (!issue) return;
    const capturedKey = issueKey;
    setSaving(true);
    try {
      if (field === "status") {
        await transitionIssue(capturedKey, value);
      } else if (field === "assignee") {
        await updateIssueField(capturedKey, "assignee", value ? { accountId: value } : null);
      } else if (field === "reporter") {
        await updateIssueField(capturedKey, "reporter", value ? { accountId: value } : null);
      } else if (field === "priority") {
        await updateIssueField(capturedKey, "priority", { id: value });
      } else if (field === "summary") {
        await updateIssueField(capturedKey, "summary", value);
      } else if (field === "description") {
        // ADF format for plain text
        const adf = {
          type: "doc",
          version: 1,
          content: value.split("\n").map((line: string) => ({
            type: "paragraph",
            content: line ? [{ type: "text", text: line }] : [],
          })),
        };
        await updateIssueField(capturedKey, "description", adf);
      } else if (field === "labels") {
        await updateIssueField(capturedKey, "labels", value);
      } else if (field === "components") {
        const components = value.map((name: string) => {
          const comp = projectComponents.find(c => c.name === name);
          return comp ? { id: comp.id } : null;
        }).filter(Boolean);
        await updateIssueField(capturedKey, "components", components);
      } else if (field === "duedate") {
        await updateIssueField(capturedKey, "duedate", value);
      } else if (field === "issueType") {
        await updateIssueField(capturedKey, "issuetype", { id: value });
      }
      if (issueKeyRef.current === capturedKey) {
        reload();
      }
      onRefresh();
    } catch (e) {
      console.error(e);
    } finally {
      if (issueKeyRef.current === capturedKey) {
        setSaving(false);
        setEditing(null);
      }
    }
  };

  if (loading) {
    const content = (
      <div className="issue-detail scrollable">
        <div className="issue-detail-header">
          <div className="issue-header">
            <div className="skeleton skeleton-badge" />
            <div className="skeleton skeleton-badge" />
          </div>
          <div className="issue-title-row">
            <div className="skeleton skeleton-title" />
          </div>
        </div>
        <div className="issue-meta">
          <div className="skeleton skeleton-meta-item" />
          <div className="skeleton skeleton-meta-item" />
          <div className="skeleton skeleton-meta-item" />
          <div className="skeleton skeleton-meta-item" />
          <div className="skeleton skeleton-meta-item" />
          <div className="skeleton skeleton-meta-item wide" />
        </div>
        <div className="issue-description">
          <div className="skeleton skeleton-label" />
          <div className="skeleton skeleton-line" />
          <div className="skeleton skeleton-line short" />
          <div className="skeleton skeleton-line" />
          <div className="skeleton skeleton-line shorter" />
        </div>
        <div className="issue-comments">
          <div className="skeleton skeleton-label" />
        </div>
      </div>
    );
    if (!renderTerminal) return content;
    return (
      <div className="issue-detail-container">
        {content}
        {showTerminal && <TerminalPanel key={issueKey} issueKey={issueKey} projectKey={getProjectKeyFromIssueKey(issueKey)} isCollapsed={terminalCollapsed} setIsCollapsed={setTerminalCollapsed} isMaximized={terminalMaximized} setIsMaximized={setTerminalMaximized} onWorktreeChange={onRefresh} />}
      </div>
    );
  }

  if (error || !issue) {
    const content = (
      <div className="issue-detail scrollable">
        <div className="issue-error">Failed to load issue</div>
      </div>
    );
    if (!renderTerminal) return content;
    return (
      <div className="issue-detail-container">
        {content}
        {showTerminal && <TerminalPanel key={issueKey} issueKey={issueKey} projectKey={getProjectKeyFromIssueKey(issueKey)} isCollapsed={terminalCollapsed} setIsCollapsed={setTerminalCollapsed} isMaximized={terminalMaximized} setIsMaximized={setTerminalMaximized} onWorktreeChange={onRefresh} />}
      </div>
    );
  }

  const formatDate = (dateStr: string) => {
    if (!dateStr) return "";
    const date = new Date(dateStr);
    return date.toLocaleDateString("ko-KR", {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  };

  const formatDateOnly = (dateStr: string) => {
    if (!dateStr) return "";
    // YYYY-MM-DD 형식은 직접 파싱 (타임존 이슈 방지)
    const [year, month, day] = dateStr.split("-").map(Number);
    const date = new Date(year, month - 1, day);
    return date.toLocaleDateString("ko-KR", {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  };

  // Format minutes to time string like "1h 30m"
  const formatMinutesToTime = (mins: number): string => {
    if (mins <= 0) return "0m";
    const hours = Math.floor(mins / 60);
    const minutes = mins % 60;
    if (hours > 0 && minutes > 0) return `${hours}h ${minutes}m`;
    if (hours > 0) return `${hours}h`;
    return `${minutes}m`;
  };

  const estimateSeconds = issue.timeTracking?.originalEstimateSeconds || 0;
  const remainingSeconds = issue.timeTracking?.remainingEstimateSeconds || 0;
  const loggedSeconds = issue.timeTracking?.timeSpentSeconds || 0;
  const totalSeconds = remainingSeconds + loggedSeconds;
  const timeExceeded = estimateSeconds > 0 ? totalSeconds > estimateSeconds : totalSeconds > 0;
  const excessMinutes = timeExceeded ? Math.floor((totalSeconds - estimateSeconds) / 60) : 0;

  const issueContent = (
    <div className="issue-detail scrollable">
      <div className="issue-detail-header">
        <div className="issue-header">
          <div
            className="issue-key-badge clickable"
            onClick={() => {
              const baseUrl = getBaseUrl();
              if (baseUrl) openUrl(`${baseUrl}/browse/${issue.key}`);
            }}
          >
            {issue.key}
          </div>
          {editing === "issueType" ? (
            <select
              className="edit-select"
              value={projectIssueTypes.find(t => t.name === issue.issueType)?.id || ""}
              onChange={(e) => saveEdit("issueType", e.target.value)}
              onBlur={() => setEditing(null)}
              autoFocus
            >
              {projectIssueTypes.map((t) => (
                <option key={t.id} value={t.id}>{t.name}</option>
              ))}
            </select>
          ) : (
            <div className="issue-type-badge editable" onClick={() => startEdit("issueType")}>
              {issue.issueType}
              <span className="edit-icon"><EditIcon /></span>
            </div>
          )}
          {issue.parentKey && (
            <div className="issue-parent">
              <span className="parent-label">Parent:</span>
              <span className="parent-link" onClick={() => onIssueClick(issue.parentKey!)}>
                {issue.parentKey}
              </span>
              {issue.parentSummary && <span className="parent-summary">{issue.parentSummary}</span>}
            </div>
          )}
          <button
            className="create-child-btn"
            onClick={() => onCreateChild(issue.projectKey, issue.key)}
          >
            + Child
          </button>
        </div>

        {editing === "summary" ? (
          <div className="edit-inline">
            <input
              type="text"
              value={editValue}
              onChange={(e) => setEditValue(e.target.value)}
              className="edit-input title"
              autoFocus
              onKeyDown={(e) => {
                if (e.key === "Enter") saveEdit("summary", editValue);
                if (e.key === "Escape") setEditing(null);
              }}
            />
            <div className="edit-actions">
              <button className="edit-save" onClick={() => saveEdit("summary", editValue)} disabled={saving}>Save</button>
              <button className="edit-cancel" onClick={() => setEditing(null)}>Cancel</button>
            </div>
          </div>
        ) : (
          <div className="issue-title-row">
            <h1 className="issue-title editable" onClick={() => startEdit("summary")}>
              {issue.summary}
              <span className="edit-icon"><EditIcon /></span>
            </h1>
            <div className="issue-copy-actions">
              <span
                className={`copy-link ${copiedKey ? "copied" : ""}`}
                onClick={() => copyToClipboard(issue.key, "key")}
              >
                {copiedKey ? "Copied" : "Copy Key"}
              </span>
              <span
                className={`copy-link ${copiedUrl ? "copied" : ""}`}
                onClick={() => {
                  const baseUrl = getBaseUrl();
                  if (baseUrl) copyToClipboard(`${baseUrl}/browse/${issue.key}`, "url");
                }}
              >
                {copiedUrl ? "Copied" : "Copy URL"}
              </span>
            </div>
          </div>
        )}
      </div>

      <div className="issue-meta">
        <div className="issue-meta-item">
          <span className="meta-label">Status</span>
          {editing === "status" ? (
            transitions.length === 0 ? (
              <span className="meta-value"><Spinner /></span>
            ) : (
              <div className="edit-dropdown">
                <select
                  className="edit-select"
                  autoFocus
                  defaultValue="__current__"
                  onChange={(e) => { if (e.target.value && e.target.value !== "__current__") saveEdit("status", e.target.value); }}
                  disabled={saving}
                >
                  <option value="__current__" disabled>{issue.status} (current)</option>
                  {transitions.map((t) => (
                    <option key={t.id} value={t.id}>{t.name}</option>
                  ))}
                </select>
                <button className="edit-cancel-small" onClick={() => setEditing(null)}>Cancel</button>
              </div>
            )
          ) : (
            <span className="meta-value status-badge editable" onClick={() => startEdit("status")} style={{ color: getStatusColor(issue.status, issue.statusCategory), background: getStatusBgColor(issue.status, issue.statusCategory) }}>
              {issue.status}
              <span className="edit-icon"><EditIcon /></span>
            </span>
          )}
        </div>

        <div className="issue-meta-item">
          <span className="meta-label">Priority</span>
          {editing === "priority" ? (
            priorities.length === 0 ? (
              <span className="meta-value"><Spinner /></span>
            ) : (
              <div className="edit-dropdown">
                <select
                  className="edit-select"
                  autoFocus
                  value={issue.priorityId}
                  onChange={(e) => saveEdit("priority", e.target.value)}
                  disabled={saving}
                >
                  {priorities.map((p) => (
                    <option key={p.id} value={p.id}>{p.name}</option>
                  ))}
                </select>
                <button className="edit-cancel-small" onClick={() => setEditing(null)}>Cancel</button>
              </div>
            )
          ) : (
            <span className="meta-value editable" onClick={() => startEdit("priority")}>
              <PriorityIcon priority={issue.priority} /> {issue.priority}
              <span className="edit-icon"><EditIcon /></span>
            </span>
          )}
        </div>

        <div className="issue-meta-item">
          <span className="meta-label">Assignee</span>
          {editing === "assignee" ? (
            users.length === 0 ? (
              <span className="meta-value"><Spinner /></span>
            ) : (
              <div className="edit-dropdown">
                <select
                  className="edit-select"
                  autoFocus
                  value={issue.assigneeId || ""}
                  onChange={(e) => saveEdit("assignee", e.target.value || null)}
                  disabled={saving}
                >
                  <option value="">Unassigned</option>
                  {users.map((u) => (
                    <option key={u.accountId} value={u.accountId}>{u.displayName}</option>
                  ))}
                </select>
                <button className="edit-cancel-small" onClick={() => setEditing(null)}>Cancel</button>
              </div>
            )
          ) : (
            <span className="meta-value editable" onClick={() => startEdit("assignee")}>
              {issue.assignee}
              <span className="edit-icon"><EditIcon /></span>
            </span>
          )}
        </div>

        <div className="issue-meta-item">
          <span className="meta-label">Reporter</span>
          {editing === "reporter" ? (
            users.length === 0 ? (
              <span className="meta-value"><Spinner /></span>
            ) : (
              <div className="edit-dropdown">
                <select
                  className="edit-select"
                  autoFocus
                  value={issue.reporterId || ""}
                  onChange={(e) => saveEdit("reporter", e.target.value || null)}
                  disabled={saving}
                >
                  {users.map((u) => (
                    <option key={u.accountId} value={u.accountId}>{u.displayName}</option>
                  ))}
                </select>
                <button className="edit-cancel-small" onClick={() => setEditing(null)}>Cancel</button>
              </div>
            )
          ) : (
            <span className="meta-value editable" onClick={() => startEdit("reporter")}>
              {issue.reporter || "Unassigned"}
              <span className="edit-icon"><EditIcon /></span>
            </span>
          )}
        </div>

        <div className="issue-meta-item">
          <span className="meta-label">Labels</span>
          {editing === "labels" ? (
            labelsLoading ? (
              <span className="meta-value"><Spinner /></span>
            ) : (
              <div className="edit-tags-container">
                <div className="edit-tags-list">
                  {[...new Set([...availableLabels, ...selectedLabels])].sort().map((label) => (
                    <span
                      key={label}
                      className={`tag-selectable ${selectedLabels.includes(label) ? "selected" : ""}`}
                      onClick={() => {
                        if (selectedLabels.includes(label)) {
                          setSelectedLabels(selectedLabels.filter(l => l !== label));
                        } else {
                          setSelectedLabels([...selectedLabels, label]);
                        }
                      }}
                    >
                      {label}
                    </span>
                  ))}
                </div>
                <button className="edit-save" onClick={() => saveEdit("labels", selectedLabels)} disabled={saving}>Save</button>
                <button className="edit-cancel-small" onClick={() => setEditing(null)}>Cancel</button>
              </div>
            )
          ) : (
            <span className="meta-value meta-value-tags editable" onClick={() => startEdit("labels")}>
              {issue.labels.length > 0 ? issue.labels.map((label) => (
                <span key={label} className="label-badge">{label}</span>
              )) : <span className="meta-empty">None</span>}
              <span className="edit-icon"><EditIcon /></span>
            </span>
          )}
        </div>

        <div className="issue-meta-item">
          <span className="meta-label">Components</span>
          {editing === "components" ? (
            componentsLoading ? (
              <span className="meta-value"><Spinner /></span>
            ) : (
              <div className="edit-tags-container">
                <div className="edit-tags-list">
                  {projectComponents.map((comp) => (
                    <span
                      key={comp.id}
                      className={`tag-selectable ${selectedComponents.includes(comp.name) ? "selected" : ""}`}
                      onClick={() => {
                        if (selectedComponents.includes(comp.name)) {
                          setSelectedComponents(selectedComponents.filter(c => c !== comp.name));
                        } else {
                          setSelectedComponents([...selectedComponents, comp.name]);
                        }
                      }}
                    >
                      {comp.name}
                    </span>
                  ))}
                </div>
                <button className="edit-save" onClick={() => saveEdit("components", selectedComponents)} disabled={saving}>Save</button>
                <button className="edit-cancel-small" onClick={() => setEditing(null)}>Cancel</button>
              </div>
            )
          ) : (
            <span className="meta-value meta-value-tags editable" onClick={() => startEdit("components")}>
              {issue.components.length > 0 ? issue.components.map((comp) => (
                <span key={comp} className="component-badge">{comp}</span>
              )) : <span className="meta-empty">None</span>}
              <span className="edit-icon"><EditIcon /></span>
            </span>
          )}
        </div>

        <div className="issue-meta-item">
          <span className="meta-label">Created</span>
          <span className="meta-value">{formatDate(issue.created)}</span>
        </div>

        <div className="issue-meta-item">
          <span className="meta-label">Updated</span>
          <span className="meta-value">{formatDate(issue.updated)}</span>
        </div>

        <div className="issue-meta-item issue-meta-item-due">
          {(() => {
            const isResolved = issue.statusCategory === "done";
            let daysUntilDue: number | null = null;
            let isOverdue = false;
            if (issue.dueDate && !isResolved) {
              const [y, m, d] = issue.dueDate.split("-").map(Number);
              const due = new Date(y, m - 1, d);
              const today = new Date();
              today.setHours(0, 0, 0, 0);
              daysUntilDue = Math.ceil((due.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
              isOverdue = daysUntilDue < 0;
            }
            return (
              <>
                <span className="meta-label">Due</span>
                <span
                  className="meta-value editable"
                  onClick={() => { if (saving) return; setEditing(editing === "duedate" ? null : "duedate"); }}
                >
                  {issue.dueDate ? (
                    <>
                      {formatDateOnly(issue.dueDate)}
                      {!isResolved && daysUntilDue !== null && (
                        <span className={`due-badge ${isOverdue ? "overdue" : daysUntilDue === 0 ? "today" : ""}`}>
                          {daysUntilDue === 0 ? "D-Day" : daysUntilDue > 0 ? `D-${daysUntilDue}` : `D+${Math.abs(daysUntilDue)}`}
                        </span>
                      )}
                    </>
                  ) : <span className="meta-empty">None</span>}
                  <span className="edit-icon"><CalendarIcon /></span>
                </span>
              </>
            );
          })()}
          {editing === "duedate" && (
            <DatePicker
              value={issue.dueDate || ""}
              onChange={(date) => {
                if (date !== issue.dueDate) {
                  saveEdit("duedate", date);
                } else {
                  setEditing(null);
                }
              }}
              onClose={() => setEditing(null)}
            />
          )}
        </div>

        <div className="issue-meta-item time-meta-item">
          <span className="meta-label">Time</span>
          <span className="meta-value time-tracking-value">
            <svg className="time-donut" viewBox="0 0 20 20">
              <circle cx="10" cy="10" r="8" fill="none" stroke="var(--bg-tertiary)" strokeWidth="3" />
              <circle
                cx="10" cy="10" r="8" fill="none" stroke={timeExceeded ? "var(--error)" : "var(--accent)"} strokeWidth="3"
                strokeDasharray={`${timeExceeded ? 50.265 : (estimateSeconds > 0 ? (loggedSeconds / estimateSeconds) * 50.265 : 0)} 50.265`}
                strokeLinecap="round"
                transform="rotate(-90 10 10)"
              />
            </svg>
            <span className="time-item">
              <span className="time-label-mini">Estimate</span>
              {editing === "estimate" ? (
                <>
                  <input
                    type="text"
                    className="edit-input-small"
                    value={estimateValue}
                    onChange={(e) => setEstimateValue(e.target.value)}
                    placeholder="2h"
                    autoFocus
                    onBlur={(e) => {
                      if (e.relatedTarget?.classList.contains("edit-cancel-small")) return;
                      if (estimateValue !== (issue.timeTracking?.originalEstimate || "")) {
                        setTimeSaving(true);
                        updateTimeEstimate(issueKey, estimateValue, null)
                          .then(() => { reload(); setEditing(null); })
                          .catch(() => setEditing(null))
                          .finally(() => setTimeSaving(false));
                      } else {
                        setEditing(null);
                      }
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                      if (e.key === "Escape") setEditing(null);
                    }}
                  />
                  <button className="edit-cancel-small" onClick={() => setEditing(null)}>Cancel</button>
                </>
              ) : (
                <span className="time-text editable" onClick={() => { if (timeSaving) return; setEditing("estimate"); setEstimateValue(issue.timeTracking?.originalEstimate || ""); }}>
                  {issue.timeTracking?.originalEstimate || "0m"}
                </span>
              )}
            </span>
            <span className="time-item">
              <span className="time-label-mini">Remaining</span>
              {editing === "remaining" ? (
                <>
                  <input
                    type="text"
                    className="edit-input-small"
                    value={remainingValue}
                    onChange={(e) => setRemainingValue(e.target.value)}
                    placeholder="1h 30m"
                    autoFocus
                    onBlur={(e) => {
                      if (e.relatedTarget?.classList.contains("edit-cancel-small")) return;
                      if (remainingValue !== (issue.timeTracking?.remainingEstimate || "")) {
                        setTimeSaving(true);
                        updateTimeEstimate(issueKey, null, remainingValue)
                          .then(() => { reload(); setEditing(null); })
                          .catch(() => setEditing(null))
                          .finally(() => setTimeSaving(false));
                      } else {
                        setEditing(null);
                      }
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                      if (e.key === "Escape") setEditing(null);
                    }}
                  />
                  <button className="edit-cancel-small" onClick={() => setEditing(null)}>Cancel</button>
                </>
              ) : (
                <span className={`time-text editable ${timeExceeded ? "time-exceeded" : ""}`} onClick={() => { if (timeSaving) return; setEditing("remaining"); setRemainingValue(issue.timeTracking?.remainingEstimate || ""); }}>
                  {issue.timeTracking?.remainingEstimate || "0m"}
                </span>
              )}
            </span>
            <span className="time-item">
              <span className="time-label-mini">Logged</span>
              <span className={`time-text editable ${timeExceeded ? "time-exceeded" : ""}`} onClick={() => { if (timeSaving) return; if (!showLogWork) { setLogTimeSpent(""); setLogComment(""); } setShowLogWork(!showLogWork); }}>
                {issue.timeTracking?.timeSpent || "0m"}
                {timeExceeded && <span className="time-excess"> (+{formatMinutesToTime(excessMinutes)})</span>}
              </span>
            </span>
          </span>
          {/* Worklogs Table */}
          {(showLogWork || issue.worklogs.length > 0) && (
            <table className="worklogs-table">
              <tbody>
                {issue.worklogs.map((log) => (
                  <tr key={log.id} className={`worklog-row ${editingWorklog === log.id ? "worklog-input-row" : ""} ${deletingWorklogs.has(log.id) ? "worklog-deleting" : ""}`}>
                    <td className="worklog-date">{formatDate(log.started)}</td>
                    <td className="worklog-time">
                      {editingWorklog === log.id ? (
                        <input
                          type="text"
                          className="log-work-input"
                          value={editWorklogTime}
                          onChange={(e) => setEditWorklogTime(e.target.value)}
                          onBlur={(e) => {
                            const row = e.currentTarget.closest("tr");
                            if (row?.contains(e.relatedTarget as Node)) return;
                            const timeChanged = editWorklogTime.trim() && editWorklogTime !== log.timeSpent;
                            const commentChanged = editWorklogComment !== (log.comment || "");
                            if (timeChanged || commentChanged) {
                              updateWorklog(issueKey, log.id, editWorklogTime || log.timeSpent, editWorklogComment)
                                .then(() => { setEditingWorklog(null); reload(); onRefresh(); })
                                .catch((err: any) => { console.error(err); setEditingWorklog(null); });
                            } else {
                              setEditingWorklog(null);
                            }
                          }}
                          onKeyDown={(e) => {
                            if (e.key === "Escape") setEditingWorklog(null);
                          }}
                          autoFocus={editWorklogField === "time"}
                        />
                      ) : (
                        <span className={deletingWorklogs.has(log.id) ? "" : "editable"} onClick={() => { if (deletingWorklogs.has(log.id)) return; setEditingWorklog(log.id); setEditWorklogField("time"); setEditWorklogTime(log.timeSpent); setEditWorklogComment(log.comment || ""); }}>{log.timeSpent}</span>
                      )}
                    </td>
                    <td className="worklog-comment">
                      {editingWorklog === log.id ? (
                        <>
                          <input
                            type="text"
                            className="log-work-input comment"
                            value={editWorklogComment}
                            onChange={(e) => setEditWorklogComment(e.target.value)}
                            onBlur={(e) => {
                              const row = e.currentTarget.closest("tr");
                              if (row?.contains(e.relatedTarget as Node)) return;
                              const timeChanged = editWorklogTime.trim() && editWorklogTime !== log.timeSpent;
                              const commentChanged = editWorklogComment !== (log.comment || "");
                              if (timeChanged || commentChanged) {
                                updateWorklog(issueKey, log.id, editWorklogTime || log.timeSpent, editWorklogComment)
                                  .then(() => { setEditingWorklog(null); reload(); onRefresh(); })
                                  .catch((err: any) => { console.error(err); setEditingWorklog(null); });
                              } else {
                                setEditingWorklog(null);
                              }
                            }}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                              if (e.key === "Escape") setEditingWorklog(null);
                            }}
                            placeholder="Comment"
                            autoFocus={editWorklogField === "comment"}
                          />
                          <button className="worklog-delete" onClick={() => setEditingWorklog(null)}>×</button>
                        </>
                      ) : (
                        <>
                          <span className={deletingWorklogs.has(log.id) ? "" : "editable"} onClick={() => { if (deletingWorklogs.has(log.id)) return; setEditingWorklog(log.id); setEditWorklogField("comment"); setEditWorklogTime(log.timeSpent); setEditWorklogComment(log.comment || ""); }}>{log.comment || ""}</span>
                          <button className="worklog-delete" disabled={deletingWorklogs.has(log.id)} onClick={async () => { setDeletingWorklogs(prev => new Set([...prev, log.id])); try { await deleteWorklog(issueKey, log.id); reload(); onRefresh(); } catch { setDeletingWorklogs(prev => { const next = new Set(prev); next.delete(log.id); return next; }); } }}>×</button>
                        </>
                      )}
                    </td>
                  </tr>
                ))}
                {showLogWork && !(worklogCountBeforeSave !== null && issue.worklogs.length > worklogCountBeforeSave) && (
                  <tr className={`worklog-row ${timeSaving ? "worklog-saving" : "worklog-input-row"}`}>
                    <td className="worklog-date">{formatDate(new Date().toISOString())}</td>
                    <td className="worklog-time">
                      {timeSaving ? (
                        <span>{logTimeSpent}</span>
                      ) : (
                        <input
                          type="text"
                          className="log-work-input"
                          value={logTimeSpent}
                          onChange={(e) => setLogTimeSpent(e.target.value)}
                          onBlur={(e) => {
                            const row = e.currentTarget.closest("tr");
                            if (row?.contains(e.relatedTarget as Node)) return;
                            setShowLogWork(false); setLogTimeSpent(""); setLogComment("");
                          }}
                          onKeyDown={(e) => {
                            if (e.key === "Escape") { setShowLogWork(false); setLogTimeSpent(""); setLogComment(""); }
                          }}
                          placeholder="1h 30m"
                          autoFocus
                        />
                      )}
                    </td>
                    <td className="worklog-comment">
                      {timeSaving ? (
                        <span>{logComment}</span>
                      ) : (
                        <>
                          <input
                            type="text"
                            className="log-work-input comment"
                            value={logComment}
                            onChange={(e) => setLogComment(e.target.value)}
                            onBlur={(e) => {
                              const row = e.currentTarget.closest("tr");
                              if (row?.contains(e.relatedTarget as Node)) return;
                              if (logTimeSpent.trim() && logComment.trim() && !timeSaving) {
                                setTimeSaving(true);
                                setWorklogCountBeforeSave(issue.worklogs.length);
                                addWorklog(issueKey, logTimeSpent, logComment)
                                  .then(() => {
                                    reload();
                                    onRefresh();
                                  })
                                  .catch((err: any) => {
                                    console.error(err);
                                    setTimeSaving(false);
                                    setWorklogCountBeforeSave(null);
                                  });
                              } else {
                                setShowLogWork(false); setLogTimeSpent(""); setLogComment("");
                              }
                            }}
                            onKeyDown={(e) => {
                              if (e.key === "Escape") { setShowLogWork(false); setLogTimeSpent(""); setLogComment(""); }
                            }}
                            placeholder="Comment"
                          /><button className="worklog-delete" onClick={() => { setShowLogWork(false); setLogTimeSpent(""); setLogComment(""); }}>×</button>
                        </>
                      )}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          )}
        </div>
      </div>

      <div className="issue-description">
        <div className="description-label editable" onClick={() => !editing && startEdit("description")}>
          Description
          <span className="edit-icon"><EditIcon /></span>
        </div>
        {editing === "description" ? (
          <div className="edit-description">
            <textarea
              value={editValue}
              onChange={(e) => setEditValue(e.target.value)}
              className="edit-textarea"
              autoFocus
            />
            <div className="edit-actions">
              <button className="edit-save" onClick={() => saveEdit("description", editValue)} disabled={saving}>
                {saving ? "Saving..." : "Save"}
              </button>
              <button className="edit-cancel" onClick={() => setEditing(null)}>Cancel</button>
            </div>
          </div>
        ) : (
          <div className="description-content">
            {issue.description ? (
              <Markdown
                remarkPlugins={[remarkGfm]}
                components={{
                  a: ({ href, children }) => (
                    <a href={href} onClick={(e) => { e.preventDefault(); if (href) openUrl(href); }}>
                      {children}
                    </a>
                  ),
                  pre: ({ children }) => <>{children}</>,
                  code: CodeBlock,
                }}
              >
                {issue.description}
              </Markdown>
            ) : (
              <span className="no-value">No description</span>
            )}
          </div>
        )}
      </div>

      <div className="issue-comments">
        <div className="comments-label">Comments ({issue.comments.length})</div>

        {issue.comments.map((comment) => (
          <div key={comment.id} className="comment-item">
            <div className="comment-header">
              <span className="comment-author">{comment.author}</span>
              <span className="comment-date">{formatDate(comment.created)}</span>
              <div className="comment-actions">
                <button className="comment-action-btn" onClick={() => {
                  setReplyTo({ author: comment.author });
                  setNewComment(`@${comment.author} `);
                }}>Reply</button>
                <button className="comment-action-btn" onClick={() => {
                  setEditingComment(comment.id);
                  setEditCommentValue(comment.body);
                }}>Edit</button>
                <button className="comment-action-btn" onClick={async () => {
                  try {
                    await deleteComment(issueKey, comment.id);
                    reload();
                  } catch (e) {
                    console.error("Delete failed:", e);
                    alert("Failed to delete comment");
                  }
                }}>Delete</button>
              </div>
            </div>
            {editingComment === comment.id ? (
              <div className="comment-edit">
                <textarea
                  className="comment-textarea"
                  value={editCommentValue}
                  onChange={(e) => setEditCommentValue(e.target.value)}
                  rows={3}
                  autoFocus
                />
                <div className="comment-form-actions">
                  <button className="edit-save" onClick={async () => {
                    await updateComment(issueKey, comment.id, editCommentValue);
                    setEditingComment(null);
                    reload();
                  }}>Save</button>
                  <button className="edit-cancel" onClick={() => setEditingComment(null)}>Cancel</button>
                </div>
              </div>
            ) : (
              <div className="comment-body">
                <Markdown
                  remarkPlugins={[remarkGfm]}
                  components={{
                    a: ({ href, children }) => (
                      <a href={href} onClick={(e) => { e.preventDefault(); if (href) openUrl(href); }}>
                        {children}
                      </a>
                    ),
                    pre: ({ children }) => <>{children}</>,
                    code: CodeBlock,
                  }}
                >
                  {comment.body}
                </Markdown>
              </div>
            )}
          </div>
        ))}

        <div className="comment-form">
          <textarea
            className="comment-textarea"
            placeholder="Add a comment..."
            value={newComment}
            onChange={(e) => setNewComment(e.target.value)}
            rows={2}
          />
          {newComment.trim() && (
            <div className="comment-form-actions">
              <button
                className="edit-save"
                disabled={addingComment}
                onClick={async () => {
                  setAddingComment(true);
                  try {
                    await addComment(issueKey, newComment);
                    setNewComment("");
                    reload();
                  } catch (e) {
                    console.error(e);
                  } finally {
                    setAddingComment(false);
                  }
                }}
              >
                {addingComment ? "Posting..." : "Post"}
              </button>
              <button className="edit-cancel" onClick={() => setNewComment("")}>Cancel</button>
            </div>
          )}
        </div>
      </div>
    </div>
  );

  if (!renderTerminal) return issueContent;

  return (
    <div className="issue-detail-container">
      {issueContent}
      {showTerminal && <TerminalPanel key={issueKey} issueKey={issueKey} projectKey={getProjectKeyFromIssueKey(issueKey)} isCollapsed={terminalCollapsed} setIsCollapsed={setTerminalCollapsed} isMaximized={terminalMaximized} setIsMaximized={setTerminalMaximized} onWorktreeChange={onRefresh} />}
    </div>
  );
}

const POLL_INTERVAL = 30000; // 30 seconds

// Diff File Tree Component
type DiffFile = {
  status: string; // M, A, D, R, etc.
  path: string;
};

type DiffTreeNode = {
  name: string;
  path: string;
  isDir: boolean;
  status?: string;
  children: DiffTreeNode[];
  expanded?: boolean;
};

function buildDiffTree(files: DiffFile[]): DiffTreeNode[] {
  const root: DiffTreeNode[] = [];

  for (const file of files) {
    const parts = file.path.split("/");
    let current = root;

    for (let i = 0; i < parts.length; i++) {
      const name = parts[i];
      const isLast = i === parts.length - 1;
      const path = parts.slice(0, i + 1).join("/");

      let node = current.find(n => n.name === name);
      if (!node) {
        node = {
          name,
          path,
          isDir: !isLast,
          status: isLast ? file.status : undefined,
          children: [],
          expanded: true,
        };
        current.push(node);
      }
      current = node.children;
    }
  }

  // Sort: folders first, then files, alphabetically within each group
  const sortNodes = (nodes: DiffTreeNode[]): DiffTreeNode[] => {
    return nodes
      .map(n => ({ ...n, children: sortNodes(n.children) }))
      .sort((a, b) => {
        if (a.isDir && !b.isDir) return -1;
        if (!a.isDir && b.isDir) return 1;
        return a.name.localeCompare(b.name);
      });
  };

  return sortNodes(root);
}

// Store expanded paths per issue
const diffTreeExpandedPaths = new Map<string, Set<string>>();


function DiffFileTree({ issueKey, onFilesCountChange, onFileSelect, selectedFile, refreshTrigger }: {
  issueKey: string | null;
  onFilesCountChange?: (count: number) => void;
  onFileSelect?: (file: DiffFile | null) => void;
  selectedFile?: string | null;
  refreshTrigger?: number;
}) {
  const [files, setFiles] = useState<DiffFile[]>([]);
  const [tree, setTree] = useState<DiffTreeNode[]>([]);
  const [expandedPaths, setExpandedPathsState] = useState<Set<string>>(() => {
    return issueKey ? (diffTreeExpandedPaths.get(issueKey) || new Set()) : new Set();
  });
  const hasInitializedExpandedPaths = useRef(false);
  const [baseBranch, setBaseBranch] = useState<string>("");
  const [branches, setBranches] = useState<string[]>([]);
  const [viewMode, setViewMode] = useState<"tree" | "flat">(() => {
    return (localStorage.getItem(`${getStoragePrefix()}diff_view_mode`) as "tree" | "flat") || "flat";
  });
  const [diffMode, setDiffMode] = useState<"base" | "current">(() => {
    return (localStorage.getItem(`${getStoragePrefix()}diff_mode`) as "base" | "current") || "current";
  });
  const [lineStats, setLineStats] = useState<{ additions: number; deletions: number }>({ additions: 0, deletions: 0 });

  // PR Checks (GitHub Actions) state
  const [prChecks, setPrChecks] = useState<PrCheck[]>([]);
  const [prChecksExpanded, setPrChecksExpanded] = useState(false);
  const [prChecksExpandedPrs, setPrChecksExpandedPrs] = useState<Set<number>>(new Set());
  const [prChecksPrInfo, setPrChecksPrInfo] = useState<Array<{ number: number; headRefName: string; baseRefName: string; reviewDecision: string }>>([]);
  const [prChecksLoading, setPrChecksLoading] = useState(false);
  const prChecksFetchIdRef = useRef(0);
  const prChecksIssueKeyRef = useRef(issueKey);
  const prChecksInitializedRef = useRef(false);
  const prChecksExpandedCache = useRef<Record<string, { expanded: boolean; expandedPrs: Set<number>; initialized: boolean }>>({});
  const [prChecksActionMsg, setPrChecksActionMsg] = useState<Record<string, string>>({}); // key: `${runId}:${checkName}`
  const prChecksTimeoutsRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  // Wrapper to save expandedPaths to global store
  const setExpandedPaths = (value: Set<string> | ((prev: Set<string>) => Set<string>)) => {
    setExpandedPathsState(prev => {
      const next = typeof value === "function" ? value(prev) : value;
      if (issueKey) {
        diffTreeExpandedPaths.set(issueKey, next);
      }
      return next;
    });
  };

  // Load worktree info and branches
  useEffect(() => {
    if (!issueKey) {
      setBaseBranch("");
      setBranches([]);
      return;
    }

    const projectKey = getProjectKeyFromIssueKey(issueKey);
    const worktreeInfo = getIssueWorktree(projectKey, issueKey);
    const issueRepoPath = worktreeInfo?.repoPath;

    if (!worktreeInfo) {
      setBaseBranch("");
      setBranches([]);
      return;
    }

    // Fetch branches from main repo and detect default branch
    if (issueRepoPath) {
      Promise.all([
        invoke<string>("run_git_command", {
          cwd: issueRepoPath,
          args: ["branch"],
        }).catch(() => ""),
        invoke<string>("run_git_command", {
          cwd: issueRepoPath,
          args: ["rev-parse", "--abbrev-ref", "HEAD"],
        }).catch(() => ""),
      ]).then(([branchOutput, currentBranch]) => {
        const branchList = branchOutput.trim().split("\n")
          .map(b => b.replace(/^[\*\+]?\s*/, "").trim())
          .filter(Boolean);
        setBranches(branchList);

        const defaultBranch = currentBranch.trim() || branchList[0] || "";
        setBaseBranch(worktreeInfo.baseBranch || defaultBranch);
      });
    } else {
      setBaseBranch(worktreeInfo.baseBranch || "");
    }
  }, [issueKey, refreshTrigger]);

  // Fetch PR checks for open/draft PRs
  const fetchPrChecks = useCallback((clearActionMsg = false) => {
    if (!issueKey) return;
    const pk = getProjectKeyFromIssueKey(issueKey);
    const wt = getIssueWorktree(pk, issueKey);
    if (!wt?.repoPath || !wt.branch) return;
    setPrChecksLoading(true);
    const fetchId = ++prChecksFetchIdRef.current;
    const repoPath = wt.repoPath;
    const branch = wt.branch;

    Promise.all([
      invoke("run_gh_command", { cwd: repoPath, args: ["pr", "list", "--head", branch, "--json", "number,state,isDraft,headRefName,baseRefName,reviewDecision", "--limit", "10"] }),
      invoke("run_gh_command", { cwd: repoPath, args: ["pr", "list", "--head", branch, "--state", "closed", "--json", "number,state,isDraft,headRefName,baseRefName,reviewDecision", "--limit", "10"] }),
    ]).then(([openRes, closedRes]: unknown[]) => {
      if (fetchId !== prChecksFetchIdRef.current) return;
      const allPrs = [...JSON.parse(openRes as string), ...JSON.parse(closedRes as string)];
      const seen = new Set<number>();
      const unique = allPrs.filter((pr: { number: number }) => { if (seen.has(pr.number)) return false; seen.add(pr.number); return true; });
      const activePrs = unique.filter((pr: { state: string; isDraft: boolean }) => pr.state === 'OPEN' || pr.isDraft);
      if (activePrs.length === 0) { setPrChecks([]); setPrChecksPrInfo([]); setPrChecksLoading(false); return; }
      setPrChecksPrInfo(activePrs.map((pr: any) => ({ number: pr.number, headRefName: pr.headRefName, baseRefName: pr.baseRefName, reviewDecision: pr.reviewDecision || '' })));
      Promise.all(activePrs.map((pr: { number: number }) =>
        invoke("run_gh_command", { cwd: repoPath, args: ["pr", "checks", String(pr.number), "--json", "name,state,description,link,startedAt,completedAt"] })
          .then((r: unknown) => {
            const raw = JSON.parse(r as string) as Array<{ name: string; state: string; link: string; startedAt: string; completedAt: string }>;
            return raw.map(c => {
              let duration: number | null = null;
              if (c.startedAt) {
                const end = c.completedAt ? new Date(c.completedAt).getTime() : Date.now();
                const start = new Date(c.startedAt).getTime();
                if (start > 0 && end >= start) duration = Math.round((end - start) / 1000);
              }
              return {
                name: c.name,
                status: ['PENDING', 'QUEUED', 'IN_PROGRESS', 'WAITING', 'REQUESTED'].includes(c.state) ? 'in_progress' : 'completed',
                conclusion: c.state === 'SUCCESS' || c.state === 'NEUTRAL' ? 'success' : c.state === 'FAILURE' || c.state === 'ERROR' || c.state === 'TIMED_OUT' || c.state === 'STARTUP_FAILURE' || c.state === 'STALE' || c.state === 'ACTION_REQUIRED' ? 'failure' : c.state === 'CANCELLED' ? 'cancelled' : c.state === 'SKIPPED' ? 'skipped' : ['PENDING', 'QUEUED', 'IN_PROGRESS', 'WAITING', 'REQUESTED'].includes(c.state) ? null : c.state.toLowerCase(),
                detailsUrl: c.link || '',
                prNumber: pr.number,
                duration,
              };
            });
          }).catch(() => [] as PrCheck[])
      )).then((results: PrCheck[][]) => {
        if (fetchId !== prChecksFetchIdRef.current) return;
        const order: Record<string, number> = { failure: 0, cancelled: 1, null: 2, skipped: 3, success: 4 };
        const sorted = results.flat().sort((a, b) => (order[String(a.conclusion)] ?? 2) - (order[String(b.conclusion)] ?? 2));
        setPrChecks(sorted);
        setPrChecksLoading(false);
        if (clearActionMsg) setPrChecksActionMsg({});
        // Expand all only on first load
        if (!prChecksInitializedRef.current && sorted.length > 0) {
          prChecksInitializedRef.current = true;
          setPrChecksExpanded(true);
          setPrChecksExpandedPrs(new Set(activePrs.map((pr: { number: number }) => pr.number)));
        }
      });
    }).catch(() => {
      if (fetchId !== prChecksFetchIdRef.current) return;
      setPrChecks([]); setPrChecksPrInfo([]); setPrChecksLoading(false);
    });
  }, [issueKey]);

  useEffect(() => {
    if (!issueKey) {
      setPrChecks([]);
      setPrChecksPrInfo([]);
      setPrChecksExpanded(false);
      setPrChecksExpandedPrs(new Set());
      setPrChecksActionMsg({});
      prChecksIssueKeyRef.current = '';
      prChecksInitializedRef.current = false;
      return;
    }
    const pk = getProjectKeyFromIssueKey(issueKey);
    const wt = getIssueWorktree(pk, issueKey);
    if (!wt?.repoPath || !wt.branch) {
      setPrChecks([]);
      setPrChecksPrInfo([]);
      setPrChecksExpanded(false);
      setPrChecksExpandedPrs(new Set());
      setPrChecksActionMsg({});
      prChecksIssueKeyRef.current = issueKey;
      prChecksInitializedRef.current = false;
      return;
    }
    const prevIssueKey = prChecksIssueKeyRef.current;
    prChecksIssueKeyRef.current = issueKey;
    if (prevIssueKey !== issueKey) {
      // Save current state
      if (prevIssueKey) {
        prChecksExpandedCache.current[prevIssueKey] = { expanded: prChecksExpanded, expandedPrs: prChecksExpandedPrs, initialized: prChecksInitializedRef.current };
      }
      setPrChecks([]);
      setPrChecksPrInfo([]);
      setPrChecksActionMsg({});
      // Restore previous state or default
      const cached = issueKey ? prChecksExpandedCache.current[issueKey] : undefined;
      if (cached) {
        setPrChecksExpanded(cached.expanded);
        setPrChecksExpandedPrs(cached.expandedPrs);
        prChecksInitializedRef.current = cached.initialized;
      } else {
        setPrChecksExpanded(false);
        setPrChecksExpandedPrs(new Set());
        prChecksInitializedRef.current = false;
      }
    }
    fetchPrChecks();
    const interval = setInterval(fetchPrChecks, 60000);
    return () => { clearInterval(interval); prChecksTimeoutsRef.current.forEach(clearTimeout); prChecksTimeoutsRef.current = []; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [issueKey, refreshTrigger]);

  // Handle base branch change
  const handleBaseBranchChange = (newBaseBranch: string) => {
    if (!issueKey) return;
    const projectKey = getProjectKeyFromIssueKey(issueKey);
    const worktreeInfo = getIssueWorktree(projectKey, issueKey);
    if (worktreeInfo) {
      const updatedInfo = { ...worktreeInfo, baseBranch: newBaseBranch };
      saveIssueWorktree(projectKey, issueKey, updatedInfo);
      setBaseBranch(newBaseBranch);
    }
  };

  // Track previous issueKey to only reset on issue change
  const prevIssueKeyRef = useRef<string | null>(null);

  // Fetch diff
  useEffect(() => {
    // Reset state only when issue changes, not on refresh/mode changes
    if (prevIssueKeyRef.current !== issueKey) {
      setFiles([]);
      setTree([]);
      setLineStats({ additions: 0, deletions: 0 });
      onFilesCountChange?.(0);
      prevIssueKeyRef.current = issueKey;
    }

    if (!issueKey) {
      return;
    }

    let cancelled = false; // Abort flag for race condition
    const projectKey = getProjectKeyFromIssueKey(issueKey);

    const fetchDiff = async () => {
      const worktreeInfo = getIssueWorktree(projectKey, issueKey);
      const currentBaseBranch = worktreeInfo?.baseBranch || baseBranch;

      if (!worktreeInfo) {
        setFiles([]);
        setTree([]);
        setLineStats({ additions: 0, deletions: 0 });
        onFilesCountChange?.(0);
        return;
      }

      // Update baseBranch if it changed
      if (worktreeInfo.baseBranch && worktreeInfo.baseBranch !== baseBranch) {
        setBaseBranch(worktreeInfo.baseBranch);
      }

      try {
        const parseOutput = (out: string, defaultStatus?: string): DiffFile[] => {
          const files = out.trim().split("\n").filter(Boolean).map(line => {
            if (defaultStatus) {
              const path = line.trim();
              if (path.endsWith('/')) return null;
              return { status: defaultStatus, path };
            }
            // git diff --name-status format: "M\tpath" or "R100\told\tnew"
            const parts = line.split("\t");
            if (parts.length < 2) return null;
            const status = parts[0].charAt(0); // M, A, D, R, C, etc.
            const path = parts[parts.length - 1];
            if (path.endsWith('/')) return null;
            return { status, path };
          }).filter((f): f is DiffFile => f !== null);

          // Filter out directories: if path X exists and path X/something also exists, X is a directory
          const allPaths = new Set(files.map(f => f.path));
          return files.filter(f => {
            // Check if any other path starts with this path + "/"
            for (const p of allPaths) {
              if (p !== f.path && p.startsWith(f.path + '/')) {
                return false; // This is a directory, skip it
              }
            }
            return true;
          });
        };

        let allFiles: DiffFile[] = [];
        let totalAdditions = 0;
        let totalDeletions = 0;

        const parseNumstat = (out: string): { additions: number; deletions: number } => {
          let add = 0, del = 0;
          for (const line of out.trim().split("\n").filter(Boolean)) {
            const parts = line.split("\t");
            if (parts.length >= 2) {
              const a = parseInt(parts[0], 10);
              const d = parseInt(parts[1], 10);
              if (!isNaN(a)) add += a;
              if (!isNaN(d)) del += d;
            }
          }
          return { additions: add, deletions: del };
        };

        if (diffMode === "base") {
          // Base mode: compare with base branch + current changes
          // Run all git commands in parallel
          const [
            committedOutput,
            committedNumstat,
            uncommittedOutput,
            uncommittedNumstat,
            stagedOutput,
            stagedNumstat,
            statusOutput,
          ] = await Promise.all([
            invoke<string>("run_git_command", { cwd: worktreeInfo.path, args: ["diff", "--name-status", `${currentBaseBranch}...HEAD`] }).catch(() => ""),
            invoke<string>("run_git_command", { cwd: worktreeInfo.path, args: ["diff", "--numstat", `${currentBaseBranch}...HEAD`] }).catch(() => ""),
            invoke<string>("run_git_command", { cwd: worktreeInfo.path, args: ["diff", "--name-status"] }).catch(() => ""),
            invoke<string>("run_git_command", { cwd: worktreeInfo.path, args: ["diff", "--numstat"] }).catch(() => ""),
            invoke<string>("run_git_command", { cwd: worktreeInfo.path, args: ["diff", "--name-status", "--cached"] }).catch(() => ""),
            invoke<string>("run_git_command", { cwd: worktreeInfo.path, args: ["diff", "--numstat", "--cached"] }).catch(() => ""),
            invoke<string>("run_git_command", { cwd: worktreeInfo.path, args: ["status", "--porcelain"] }).catch(() => ""),
          ]);

          // Parse untracked files from porcelain output (lines starting with "??")
          const untrackedPaths = statusOutput.trim().split("\n").filter(Boolean)
            .filter(line => line.startsWith("?? "))
            .map(line => line.slice(3)); // Remove "?? " prefix

          // Expand untracked directories to their files (respecting .gitignore)
          const untrackedResults = await Promise.all(
            untrackedPaths.map(async (p) => {
              if (p.endsWith('/')) {
                // Directory: use git ls-files to respect .gitignore
                const output = await invoke<string>("run_git_command", {
                  cwd: worktreeInfo.path,
                  args: ["ls-files", "--others", "--exclude-standard", "--", p],
                }).catch(() => "");
                return output.trim().split("\n").filter(Boolean);
              } else {
                return [p];
              }
            })
          );
          const untrackedFiles = untrackedResults.flat();

          const rawFiles = [
            ...parseOutput(committedOutput),
            ...parseOutput(uncommittedOutput),
            ...parseOutput(stagedOutput),
            ...untrackedFiles.map(path => ({ status: "A", path })),
          ];

          // Filter out symlinks and directories (but keep deleted files)
          const filesToCheck = rawFiles.filter(f => f.status !== "D");
          const deletedFiles = rawFiles.filter(f => f.status === "D");

          // Run filter_real_files and untracked line count in parallel
          const [realFilePaths, untrackedLineResults] = await Promise.all([
            invoke<string[]>("filter_real_files", {
              basePath: worktreeInfo.path,
              paths: filesToCheck.map(f => f.path),
            }).catch(() => filesToCheck.map(f => f.path)),
            Promise.all(
              untrackedFiles.map(file =>
                invoke<string>("run_git_command", {
                  cwd: worktreeInfo.path,
                  args: ["diff", "--numstat", "--no-index", "/dev/null", file],
                }).catch(() => "")
              )
            ),
          ]);

          const realFileSet = new Set(realFilePaths);
          allFiles = [
            ...filesToCheck.filter(f => realFileSet.has(f.path)),
            ...deletedFiles,
          ];

          const untrackedLines = untrackedLineResults.reduce((sum, r) => sum + parseNumstat(r).additions, 0);
          const committedStats = parseNumstat(committedNumstat);
          const uncommittedStats = parseNumstat(uncommittedNumstat);
          const stagedStats = parseNumstat(stagedNumstat);
          totalAdditions = committedStats.additions + uncommittedStats.additions + stagedStats.additions + untrackedLines;
          totalDeletions = committedStats.deletions + uncommittedStats.deletions + stagedStats.deletions;
        } else {
          // Current mode: unstaged + staged + untracked
          // Run all git commands in parallel
          const [
            uncommittedOutput,
            uncommittedNumstat,
            stagedOutput,
            stagedNumstat,
            statusOutput,
          ] = await Promise.all([
            invoke<string>("run_git_command", { cwd: worktreeInfo.path, args: ["diff", "--name-status"] }).catch(() => ""),
            invoke<string>("run_git_command", { cwd: worktreeInfo.path, args: ["diff", "--numstat"] }).catch(() => ""),
            invoke<string>("run_git_command", { cwd: worktreeInfo.path, args: ["diff", "--name-status", "--cached"] }).catch(() => ""),
            invoke<string>("run_git_command", { cwd: worktreeInfo.path, args: ["diff", "--numstat", "--cached"] }).catch(() => ""),
            invoke<string>("run_git_command", { cwd: worktreeInfo.path, args: ["status", "--porcelain"] }).catch(() => ""),
          ]);

          // Parse untracked files from porcelain output (lines starting with "??")
          const untrackedPaths = statusOutput.trim().split("\n").filter(Boolean)
            .filter(line => line.startsWith("?? "))
            .map(line => line.slice(3)); // Remove "?? " prefix

          // Expand untracked directories to their files (respecting .gitignore)
          const untrackedResults = await Promise.all(
            untrackedPaths.map(async (p) => {
              if (p.endsWith('/')) {
                // Directory: use git ls-files to respect .gitignore
                const output = await invoke<string>("run_git_command", {
                  cwd: worktreeInfo.path,
                  args: ["ls-files", "--others", "--exclude-standard", "--", p],
                }).catch(() => "");
                return output.trim().split("\n").filter(Boolean);
              } else {
                return [p];
              }
            })
          );
          const untrackedFiles = untrackedResults.flat();

          const rawFiles = [
            ...parseOutput(uncommittedOutput),
            ...parseOutput(stagedOutput),
            ...untrackedFiles.map(path => ({ status: "A", path })),
          ];

          // Filter out symlinks and directories (but keep deleted files)
          const filesToCheck = rawFiles.filter(f => f.status !== "D");
          const deletedFiles = rawFiles.filter(f => f.status === "D");

          // Run filter_real_files and untracked line count in parallel
          const [realFilePaths, untrackedLineResults] = await Promise.all([
            invoke<string[]>("filter_real_files", {
              basePath: worktreeInfo.path,
              paths: filesToCheck.map(f => f.path),
            }).catch(() => filesToCheck.map(f => f.path)),
            Promise.all(
              untrackedFiles.map(file =>
                invoke<string>("run_git_command", {
                  cwd: worktreeInfo.path,
                  args: ["diff", "--numstat", "--no-index", "/dev/null", file],
                }).catch(() => "")
              )
            ),
          ]);

          const realFileSet = new Set(realFilePaths);
          allFiles = [
            ...filesToCheck.filter(f => realFileSet.has(f.path)),
            ...deletedFiles,
          ];

          const untrackedLines = untrackedLineResults.reduce((sum, r) => sum + parseNumstat(r).additions, 0);
          const uncommittedStats = parseNumstat(uncommittedNumstat);
          const stagedStats = parseNumstat(stagedNumstat);
          totalAdditions = uncommittedStats.additions + stagedStats.additions + untrackedLines;
          totalDeletions = uncommittedStats.deletions + stagedStats.deletions;
        }

        // Deduplicate by path (later entries override earlier ones)
        const uniqueFiles = Array.from(
          new Map(allFiles.map(f => [f.path, f])).values()
        );

        // Ignore if issue changed while fetching
        if (cancelled) return;

        setFiles(uniqueFiles);
        setTree(buildDiffTree(uniqueFiles));
        onFilesCountChange?.(uniqueFiles.length);
        setLineStats({ additions: totalAdditions, deletions: totalDeletions });

        // Close diff viewer if selected file is no longer in the list
        if (selectedFile && !uniqueFiles.some(f => f.path === selectedFile)) {
          onFileSelect?.(null);
        }
      } catch (e) {
        if (cancelled) return;
        console.error("Failed to fetch diff:", e);
        setFiles([]);
        setTree([]);
        onFilesCountChange?.(0);
        setLineStats({ additions: 0, deletions: 0 });
      }
    };

    // Quick check function - only runs git status to detect changes
    let lastStatusHash = "";
    let fetching = false;
    const quickCheck = async () => {
      if (cancelled || fetching) return;
      const worktreeInfo = getIssueWorktree(projectKey, issueKey);
      if (!worktreeInfo) return;

      try {
        // Fast status check
        const statusOutput = await invoke<string>("run_git_command", {
          cwd: worktreeInfo.path,
          args: ["status", "--porcelain"],
        }).catch(() => "");

        if (cancelled) return;

        // Compare with last status
        if (statusOutput !== lastStatusHash) {
          lastStatusHash = statusOutput;
          fetching = true;
          await fetchDiff();
          fetching = false;
        }
      } catch {
        // Ignore errors in quick check
        fetching = false;
      }
    };

    // Initial fetch with fetching flag
    fetching = true;
    fetchDiff().finally(() => { fetching = false; });

    // Only start interval if worktree exists
    const worktreeExists = !!getIssueWorktree(projectKey, issueKey);
    const interval = worktreeExists ? setInterval(quickCheck, 1000) : null;

    return () => {
      cancelled = true;
      if (interval) clearInterval(interval);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [issueKey, baseBranch, diffMode, refreshTrigger]);

  // Restore or initialize expanded paths when issue changes
  useEffect(() => {
    if (issueKey) {
      const saved = diffTreeExpandedPaths.get(issueKey);
      if (saved) {
        setExpandedPathsState(saved);
        hasInitializedExpandedPaths.current = true;
      } else {
        // Start with empty set, auto-expand effect will handle expansion
        setExpandedPathsState(new Set());
        hasInitializedExpandedPaths.current = false;
      }
    }
  }, [issueKey]);

  // Auto-expand new directories when tree changes
  useEffect(() => {
    if (tree.length > 0 && issueKey) {
      const allDirPaths = new Set<string>();
      const collectDirs = (nodes: DiffTreeNode[]) => {
        for (const node of nodes) {
          if (node.isDir) {
            allDirPaths.add(node.path);
            collectDirs(node.children);
          }
        }
      };
      collectDirs(tree);

      // Add new directories to expanded paths (keep existing collapsed state)
      setExpandedPaths(prev => {
        // If first load (no saved state), expand all directories
        if (!hasInitializedExpandedPaths.current && prev.size === 0 && allDirPaths.size > 0) {
          hasInitializedExpandedPaths.current = true;
          return allDirPaths;
        }

        let hasNew = false;
        for (const path of allDirPaths) {
          if (!prev.has(path)) {
            hasNew = true;
            break;
          }
        }
        if (!hasNew) return prev; // No change, avoid re-render

        const next = new Set(prev);
        for (const path of allDirPaths) {
          if (!prev.has(path)) {
            next.add(path); // Auto-expand new directories
          }
        }
        return next;
      });
    }
  }, [tree, issueKey]);

  const toggleExpand = (path: string) => {
    setExpandedPaths(prev => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  };

  const toggleViewMode = () => {
    const newMode = viewMode === "tree" ? "flat" : "tree";
    setViewMode(newMode);
    localStorage.setItem(`${getStoragePrefix()}diff_view_mode`, newMode);
  };

  const expandAll = () => {
    const allDirPaths = new Set<string>();
    const collectDirs = (nodes: DiffTreeNode[]) => {
      for (const node of nodes) {
        if (node.isDir) {
          allDirPaths.add(node.path);
          collectDirs(node.children);
        }
      }
    };
    collectDirs(tree);
    setExpandedPaths(allDirPaths);
  };

  const collapseAll = () => {
    setExpandedPaths(new Set());
  };

  const isAllExpanded = tree.length > 0 && expandedPaths.size > 0;

  const getStatusColor = (status: string) => {
    switch (status) {
      case "A": case "?": return "var(--status-added)";
      case "D": return "var(--status-deleted)";
      case "M": return "var(--status-modified)";
      case "R": return "var(--status-renamed)";
      default: return "var(--text-secondary)";
    }
  };

  const getStatusLabel = (status: string) => {
    switch (status) {
      case "A": return "Added";
      case "?": return "Untracked";
      case "D": return "Deleted";
      case "M": return "Modified";
      case "R": return "Renamed";
      default: return status;
    }
  };

  const renderNode = (node: DiffTreeNode, depth: number = 0): React.ReactNode => {
    const isExpanded = expandedPaths.has(node.path);

    if (node.isDir) {
      return (
        <div key={node.path}>
          <div
            className="diff-tree-item diff-tree-dir"
            style={{ '--depth': depth } as React.CSSProperties}
            onClick={() => toggleExpand(node.path)}
          >
            <span className="diff-tree-status-slot">
              <svg className={`diff-tree-chevron ${isExpanded ? "open" : ""}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polyline points="9 18 15 12 9 6" />
              </svg>
            </span>
            <span className="diff-tree-name">{node.name}</span>
          </div>
          {isExpanded && (
            <div className="diff-tree-children" style={{ '--depth': depth } as React.CSSProperties}>
              {node.children.map(child => renderNode(child, 0))}
            </div>
          )}
        </div>
      );
    }

    return (
      <div
        key={node.path}
        className={`diff-tree-item diff-tree-file ${selectedFile === node.path ? "selected" : ""}`}
        style={{ '--depth': depth } as React.CSSProperties}
        title={`${getStatusLabel(node.status || "")} - ${node.path}`}
        onClick={() => onFileSelect?.({ path: node.path, status: node.status || "" })}
      >
        <span className="diff-tree-status" style={{ color: getStatusColor(node.status || "") }}>
          {node.status}
        </span>
        <span className="diff-tree-name" style={{ color: getStatusColor(node.status || "") }}>
          {node.name}
        </span>
      </div>
    );
  };

  const projectKey = issueKey ? getProjectKeyFromIssueKey(issueKey) : "";
  const worktreeInfo = issueKey ? getIssueWorktree(projectKey, issueKey) : null;

  return (
    <div className="diff-tree">
      <div className="diff-tree-header">
        <div className="diff-tree-mode-toggle">
          <button
            className="diff-tree-view-toggle"
            onClick={() => {
              if (!issueKey || !worktreeInfo) return;
              const newMode = diffMode === "current" ? "base" : "current";
              setDiffMode(newMode);
              localStorage.setItem(`${getStoragePrefix()}diff_mode`, newMode);
            }}
            disabled={!issueKey || !worktreeInfo}
            title={diffMode === "current" ? "Show changes vs base branch" : "Show working changes only"}
          >
            {diffMode === "current" ? (
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M12 20h9" />
                <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
              </svg>
            ) : (
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="6" y1="3" x2="6" y2="15" />
                <circle cx="18" cy="6" r="3" />
                <circle cx="6" cy="18" r="3" />
                <path d="M18 9a9 9 0 0 1-9 9" />
              </svg>
            )}
          </button>
          {diffMode === "base" ? (
            <select
              className="diff-tree-base-dropdown"
              value={baseBranch}
              onChange={(e) => handleBaseBranchChange(e.target.value)}
              disabled={!issueKey || !worktreeInfo}
            >
              {branches.map(b => (
                <option key={b} value={b}>{b}</option>
              ))}
              {!branches.includes(baseBranch) && baseBranch && (
                <option value={baseBranch}>{baseBranch}</option>
              )}
            </select>
          ) : (
            <span className="diff-tree-mode-label">Uncommitted</span>
          )}
          {files.length > 0 && (
            <span className="diff-line-stats">
              <span className="diff-stat-add">+{lineStats.additions.toLocaleString()}</span>
              {' '}
              <span className="diff-stat-del">-{lineStats.deletions.toLocaleString()}</span>
            </span>
          )}
        </div>
        {viewMode === "tree" && (
          <button className="diff-tree-view-toggle" onClick={isAllExpanded ? collapseAll : expandAll} title={isAllExpanded ? "Collapse all" : "Expand all"} disabled={!worktreeInfo}>
            {isAllExpanded ? (
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polyline points="4 14 10 14 10 20" />
                <polyline points="20 10 14 10 14 4" />
                <line x1="14" y1="10" x2="21" y2="3" />
                <line x1="3" y1="21" x2="10" y2="14" />
              </svg>
            ) : (
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polyline points="15 3 21 3 21 9" />
                <polyline points="9 21 3 21 3 15" />
                <line x1="21" y1="3" x2="14" y2="10" />
                <line x1="3" y1="21" x2="10" y2="14" />
              </svg>
            )}
          </button>
        )}
        <button className="diff-tree-view-toggle" onClick={toggleViewMode} title={viewMode === "tree" ? "Switch to flat view" : "Switch to tree view"} disabled={!worktreeInfo}>
          {viewMode === "tree" ? (
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="3" y1="6" x2="21" y2="6" />
              <line x1="3" y1="12" x2="21" y2="12" />
              <line x1="3" y1="18" x2="21" y2="18" />
            </svg>
          ) : (
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
            </svg>
          )}
        </button>
      </div>
      {!issueKey ? (
        <div className="diff-tree-empty-message">Issue not selected</div>
      ) : !worktreeInfo ? (
        <div className="diff-tree-empty-message">Worktree not created</div>
      ) : files.length === 0 ? (
        <div className="diff-tree-empty">No changes</div>
      ) : viewMode === "tree" ? (
        <div className="diff-tree-content">
          {tree.map(node => renderNode(node))}
        </div>
      ) : (
        <div className="diff-tree-content">
          {(() => {
            const flattenTree = (nodes: DiffTreeNode[]): DiffFile[] => {
              const result: DiffFile[] = [];
              for (const node of nodes) {
                if (node.isDir) {
                  result.push(...flattenTree(node.children));
                } else {
                  const f = files.find(f => f.path === node.path);
                  if (f) result.push(f);
                }
              }
              return result;
            };
            return flattenTree(tree);
          })().map(file => (
            <div
              key={file.path}
              className={`diff-tree-item diff-tree-file diff-tree-flat ${selectedFile === file.path ? "selected" : ""}`}
              title={`${getStatusLabel(file.status)} - ${file.path}`}
              onClick={() => onFileSelect?.(file)}
            >
              <span className="diff-tree-status" style={{ color: getStatusColor(file.status) }}>
                {file.status}
              </span>
              <span className="diff-tree-name" style={{ color: getStatusColor(file.status) }}>
                {file.path}
              </span>
            </div>
          ))}
        </div>
      )}
      <div className="pr-checks-section">
          <div className={`pr-checks-toggle${prChecksExpanded ? ' expanded' : ''}`} onClick={() => setPrChecksExpanded(!prChecksExpanded)}>
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
              <path d={prChecksExpanded ? "M2.5 4.5L6 8L9.5 4.5" : "M9.5 7.5L6 4L2.5 7.5"} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <span className="pr-checks-toggle-label">Actions</span>
            <span className="pr-checks-summary">
              {(() => {
                const f = prChecks.filter(c => c.conclusion === 'failure').length;
                const ca = prChecks.filter(c => c.conclusion === 'cancelled').length;
                const r = prChecks.filter(c => !c.conclusion).length;
                const sk = prChecks.filter(c => c.conclusion === 'skipped').length;
                const s = prChecks.filter(c => c.conclusion === 'success').length;
                return (
                  <>
                    {f > 0 && <span className="pr-checks-count-icon failure"><svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="3"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>{f}</span>}
                    {ca > 0 && <span className="pr-checks-count-icon cancelled"><svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="3"><circle cx="12" cy="12" r="10" /><line x1="8" y1="12" x2="16" y2="12" /></svg>{ca}</span>}
                    {r > 0 && <span className="pr-checks-count-icon pending"><svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="3"><circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" /></svg>{r}</span>}
                    {sk > 0 && <span className="pr-checks-count-icon skipped"><svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="3"><polygon points="5 4 15 12 5 20" /><line x1="19" y1="5" x2="19" y2="19" /></svg>{sk}</span>}
                    {s > 0 && <span className="pr-checks-count-icon success"><svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="3"><polyline points="20 6 9 17 4 12" /></svg>{s}</span>}
                  </>
                );
              })()}
            </span>
            <button className={`pr-checks-refresh ${prChecksLoading ? 'loading' : ''}`} onClick={(e) => { e.stopPropagation(); fetchPrChecks(true); }} title="Refresh">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="12" height="12">
                <path d="M1 4v6h6" /><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
              </svg>
            </button>
          </div>
          {prChecksExpanded && (
            <div className="pr-checks-list">
              {prChecks.length === 0 && <div className="pr-checks-empty">No checks found</div>}
              {prChecksPrInfo.map(pr => {
                const checks = prChecks.filter(c => c.prNumber === pr.number);
                if (checks.length === 0) return null;
                const isExpanded = prChecksExpandedPrs.has(pr.number);
                const prF = checks.filter(c => c.conclusion === 'failure').length;
                const prCa = checks.filter(c => c.conclusion === 'cancelled').length;
                const prR = checks.filter(c => !c.conclusion).length;
                const prSk = checks.filter(c => c.conclusion === 'skipped').length;
                const prS = checks.filter(c => c.conclusion === 'success').length;
                return (
                  <div key={pr.number} className="pr-checks-pr-section">
                    <div className="pr-checks-pr-header" onClick={() => setPrChecksExpandedPrs(prev => { const next = new Set(prev); if (next.has(pr.number)) next.delete(pr.number); else next.add(pr.number); return next; })}>
                      <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                        <path d={isExpanded ? "M2.5 4.5L6 8L9.5 4.5" : "M9.5 7.5L6 4L2.5 7.5"} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                      <span className="pr-checks-pr-title">#{pr.number}</span>
                      {pr.reviewDecision && (
                        <span className={`pr-checks-review ${pr.reviewDecision === 'APPROVED' ? 'approved' : pr.reviewDecision === 'CHANGES_REQUESTED' ? 'changes' : 'pending'}`} title={pr.reviewDecision === 'APPROVED' ? 'Approved' : pr.reviewDecision === 'CHANGES_REQUESTED' ? 'Changes requested' : 'Review required'}>
                          {pr.reviewDecision === 'APPROVED' ? (
                            <svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="20 6 9 17 4 12" /></svg>
                          ) : pr.reviewDecision === 'CHANGES_REQUESTED' ? (
                            <svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" /><path d="M18.5 2.5a2.12 2.12 0 013 3L12 15l-4 1 1-4 9.5-9.5z" /></svg>
                          ) : (
                            <svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" /><circle cx="12" cy="12" r="3" /></svg>
                          )}
                        </span>
                      )}
                      <span className="pr-checks-pr-branch">{pr.headRefName} → {pr.baseRefName}</span>
                      <span className="pr-checks-summary">
                        {prF > 0 && <span className="pr-checks-count-icon failure"><svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="3"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>{prF}</span>}
                        {prCa > 0 && <span className="pr-checks-count-icon cancelled"><svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="3"><circle cx="12" cy="12" r="10" /><line x1="8" y1="12" x2="16" y2="12" /></svg>{prCa}</span>}
                        {prR > 0 && <span className="pr-checks-count-icon pending"><svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="3"><circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" /></svg>{prR}</span>}
                        {prSk > 0 && <span className="pr-checks-count-icon skipped"><svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="3"><polygon points="5 4 15 12 5 20" /><line x1="19" y1="5" x2="19" y2="19" /></svg>{prSk}</span>}
                        {prS > 0 && <span className="pr-checks-count-icon success"><svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="3"><polyline points="20 6 9 17 4 12" /></svg>{prS}</span>}
                      </span>
                    </div>
                    {isExpanded && checks.map((check, i) => {
                      const runId = check.detailsUrl?.match(/\/runs\/(\d+)/)?.[1];
                      const actionKey = runId ? `${runId}:${check.name}` : null;
                      return (
                        <div key={i} className="pr-checks-item" onClick={() => check.detailsUrl && openUrl(check.detailsUrl)} style={{ cursor: check.detailsUrl ? 'pointer' : 'default' }}>
                          {actionKey && prChecksActionMsg[actionKey] && <div className="pr-checks-action-overlay">{prChecksActionMsg[actionKey]}</div>}
                          <span className={`pr-checks-dot ${check.conclusion === 'success' ? 'success' : check.conclusion === 'failure' || check.conclusion === 'cancelled' ? 'failure' : check.conclusion === 'skipped' ? 'skipped' : 'pending'}`} />
                          <span className="pr-checks-name">{check.name}</span>
                          {check.duration != null && (
                            <span className="pr-checks-duration">
                              {check.duration >= 60 ? `${Math.floor(check.duration / 60)}m ${check.duration % 60}s` : `${check.duration}s`}
                            </span>
                          )}
                          <span className={`pr-checks-status ${check.conclusion === 'success' ? 'success' : check.conclusion === 'failure' || check.conclusion === 'cancelled' ? 'failure' : check.conclusion === 'skipped' ? 'skipped' : 'pending'}`}>
                            {check.conclusion || 'running'}
                          </span>
                          {actionKey && check.status === 'completed' && (
                            <button className="pr-checks-action-btn" title="Re-run" style={prChecksActionMsg[actionKey] ? { visibility: 'hidden' } : undefined} onClick={(e) => {
                              e.stopPropagation();
                              const pk = getProjectKeyFromIssueKey(issueKey!);
                              const wt = getIssueWorktree(pk, issueKey!);
                              if (!wt?.repoPath) return;
                              // Mark all jobs in same run with overlay
                              setPrChecksActionMsg(prev => {
                                const next = { ...prev };
                                checks.filter(c => c.detailsUrl?.match(new RegExp(`/runs/${runId}(/|$)`))).forEach(c => { next[`${runId}:${c.name}`] = 'Re-run requested'; });
                                return next;
                              });
                              invoke("run_gh_command", { cwd: wt.repoPath, args: ["run", "rerun", runId!] }).then(() => {
                                prChecksTimeoutsRef.current.push(setTimeout(() => fetchPrChecks(true), 5000));
                              }).catch(() => fetchPrChecks(true));
                            }}>
                              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="11" height="11"><path d="M1 4v6h6" /><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" /></svg>
                            </button>
                          )}
                          {actionKey && check.status === 'in_progress' && (
                            <button className="pr-checks-action-btn" title="Cancel" style={prChecksActionMsg[actionKey] ? { visibility: 'hidden' } : undefined} onClick={(e) => {
                              e.stopPropagation();
                              const pk = getProjectKeyFromIssueKey(issueKey!);
                              const wt = getIssueWorktree(pk, issueKey!);
                              if (!wt?.repoPath) return;
                              // Mark all jobs in same run with overlay
                              setPrChecksActionMsg(prev => {
                                const next = { ...prev };
                                checks.filter(c => c.detailsUrl?.match(new RegExp(`/runs/${runId}(/|$)`))).forEach(c => { next[`${runId}:${c.name}`] = 'Cancel requested'; });
                                return next;
                              });
                              invoke("run_gh_command", { cwd: wt.repoPath, args: ["run", "cancel", runId!] }).then(() => {
                                prChecksTimeoutsRef.current.push(setTimeout(() => fetchPrChecks(true), 5000));
                              }).catch(() => fetchPrChecks(true));
                            }}>
                              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" width="11" height="11"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
                            </button>
                          )}
                        </div>
                      );
                    })}
                  </div>
                );
              })}
            </div>
          )}
      </div>
    </div>
  );
}

// File Diff Viewer Component
type DiffLine = { type: 'add' | 'del' | 'context' | 'expand'; content: string; oldNum?: number; newNum?: number; expandLines?: number; expandStart?: number };
type DiffHunk = {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: DiffLine[];
};

function getLanguageFromPath(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() || '';
  const langMap: Record<string, string> = {
    ts: 'typescript', tsx: 'tsx', js: 'javascript', jsx: 'jsx',
    py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java',
    c: 'c', cpp: 'cpp', h: 'c', hpp: 'cpp', cs: 'csharp',
    css: 'css', scss: 'scss', less: 'less', html: 'html', xml: 'xml',
    json: 'json', yaml: 'yaml', yml: 'yaml', md: 'markdown',
    sh: 'bash', bash: 'bash', zsh: 'bash', sql: 'sql',
    swift: 'swift', kt: 'kotlin', php: 'php', vue: 'vue', svelte: 'svelte',
  };
  return langMap[ext] || 'text';
}


function FileDiffViewer({ issueKey, file, onBack }: {
  issueKey: string;
  file: DiffFile;
  onBack: () => void;
}) {
  const [hunks, setHunks] = useState<DiffHunk[]>([]);
  const [modeChange, setModeChange] = useState<{ oldMode: string; newMode: string } | null>(null);
  const [displayedFile, setDisplayedFile] = useState(file);
  // Track which gaps are expanded (always start collapsed)
  const [expandedGaps, setExpandedGaps] = useState<Set<number>>(new Set());
  const lastFilePathRef = useRef(file.path);
  const contentRef = useRef<HTMLDivElement>(null);

  const projectKey = getProjectKeyFromIssueKey(issueKey);
  const worktreeInfo = getIssueWorktree(projectKey, issueKey);
  const cancelledRef = useRef(false);

  const openInZed = async () => {
    if (!worktreeInfo) return;
    try {
      const fullPath = `${worktreeInfo.path}/${displayedFile.path}`;
      await invoke("open_in_zed", { path: fullPath });
    } catch (e) {
      console.error("Failed to open in Zed:", e);
    }
  };

  const toggleGap = (hunkIdx: number) => {
    setExpandedGaps(prev => {
      const next = new Set(prev);
      if (next.has(hunkIdx)) {
        next.delete(hunkIdx);
      } else {
        next.add(hunkIdx);
      }
      return next;
    });
  };

  const language = getLanguageFromPath(displayedFile.path);

  const parseDiff = (diffText: string, isNewFile: boolean): DiffHunk[] => {
    const lines = diffText.split('\n').filter((line, idx, arr) =>
      // Remove trailing empty line
      !(idx === arr.length - 1 && line === '')
    );
    const result: DiffHunk[] = [];
    let currentHunk: DiffHunk | null = null;
    let oldLineNum = 0;
    let newLineNum = 0;

    for (const line of lines) {
      // Skip metadata
      if (line.startsWith('diff --git') || line.startsWith('index ') ||
          line.startsWith('---') || line.startsWith('+++') ||
          line.startsWith('new file mode') || line.startsWith('deleted file mode') ||
          line.startsWith('old mode') || line.startsWith('new mode') ||
          line.startsWith('similarity index') || line.startsWith('rename from') ||
          line.startsWith('rename to') || line.startsWith('Binary files') ||
          line === '\\ No newline at end of file') {
        continue;
      }

      // Parse hunk header
      const hunkMatch = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
      if (hunkMatch) {
        if (currentHunk) result.push(currentHunk);
        oldLineNum = parseInt(hunkMatch[1]);
        newLineNum = parseInt(hunkMatch[3]);
        currentHunk = {
          oldStart: oldLineNum,
          oldCount: parseInt(hunkMatch[2] || '1'),
          newStart: newLineNum,
          newCount: parseInt(hunkMatch[4] || '1'),
          lines: []
        };
        continue;
      }

      if (!currentHunk && !isNewFile) continue;

      // For new files without hunk headers
      if (!currentHunk && isNewFile) {
        currentHunk = { oldStart: 0, oldCount: 0, newStart: 1, newCount: lines.length, lines: [] };
        newLineNum = 1;
      }

      if (line.startsWith('+')) {
        currentHunk!.lines.push({ type: 'add', content: line.slice(1), newNum: newLineNum++ });
      } else if (line.startsWith('-')) {
        currentHunk!.lines.push({ type: 'del', content: line.slice(1), oldNum: oldLineNum++ });
      } else {
        currentHunk!.lines.push({ type: 'context', content: line.startsWith(' ') ? line.slice(1) : line, oldNum: oldLineNum++, newNum: newLineNum++ });
      }
    }

    if (currentHunk) result.push(currentHunk);
    return result;
  };

  const fetchDiff = useCallback(async () => {
    const projectKey = getProjectKeyFromIssueKey(issueKey);
    const worktreeInfo = getIssueWorktree(projectKey, issueKey);

    if (!worktreeInfo) {
      if (cancelledRef.current) return;
      setHunks([]);
      setDisplayedFile(file);
      return;
    }

    // Get diffMode from localStorage to match DiffFileTree behavior
    const diffMode = localStorage.getItem(`${getStoragePrefix()}diff_mode`) || "current";
    const baseBranch = worktreeInfo.baseBranch;

    // Context lines for diff (reasonable default, expandable sections handle the rest)
    const ctx = 100;

    try {
      let diffOutput = "";
      let isNewFile = false;

      if (file.status === "A") {
        isNewFile = true;
        const content = await invoke<string>("read_file", {
          path: `${worktreeInfo.path}/${file.path}`,
        }).catch(() => "");
        diffOutput = content.split("\n").map(line => `+${line}`).join("\n");
      } else if (file.status === "D") {
        diffOutput = await invoke<string>("run_git_command", {
          cwd: worktreeInfo.path,
          args: ["diff", `--unified=${ctx}`, "HEAD", "--", file.path],
        }).catch(() => "");
      } else {
        if (diffMode === "base" && baseBranch) {
          // Base mode: compare merge-base with working directory (includes uncommitted changes)
          const mergeBase = await invoke<string>("run_git_command", {
            cwd: worktreeInfo.path,
            args: ["merge-base", baseBranch, "HEAD"],
          }).catch(() => "");

          if (mergeBase.trim()) {
            diffOutput = await invoke<string>("run_git_command", {
              cwd: worktreeInfo.path,
              args: ["diff", `--unified=${ctx}`, mergeBase.trim(), "--", file.path],
            }).catch(() => "");
          }
        } else {
          // Current mode: show staged + unstaged changes (parallel fetch)
          const [stagedDiff, unstagedDiff] = await Promise.all([
            invoke<string>("run_git_command", {
              cwd: worktreeInfo.path,
              args: ["diff", `--unified=${ctx}`, "--cached", "--", file.path],
            }).catch(() => ""),
            invoke<string>("run_git_command", {
              cwd: worktreeInfo.path,
              args: ["diff", `--unified=${ctx}`, "--", file.path],
            }).catch(() => ""),
          ]);

          // Use whichever has content (prefer unstaged as it's more current)
          diffOutput = unstagedDiff || stagedDiff;
        }
      }

      // Check if cancelled before updating state
      if (cancelledRef.current) return;

      const parsed = parseDiff(diffOutput, isNewFile);
      setHunks(parsed);
      setDisplayedFile(file);

      // Detect mode change
      const oldModeMatch = diffOutput.match(/old mode (\d+)/);
      const newModeMatch = diffOutput.match(/new mode (\d+)/);
      if (oldModeMatch && newModeMatch) {
        setModeChange({ oldMode: oldModeMatch[1], newMode: newModeMatch[1] });
      } else {
        setModeChange(null);
      }

      // Reset expanded state and scroll when file changes
      if (lastFilePathRef.current !== file.path) {
        setExpandedGaps(new Set());
        lastFilePathRef.current = file.path;
        contentRef.current?.scrollTo(0, 0);
      }
    } catch (e) {
      if (cancelledRef.current) return;
      console.error("Failed to fetch diff:", e);
      setHunks([]);
      setModeChange(null);
      setDisplayedFile(file);
    }
  }, [issueKey, file]);

  useEffect(() => {
    cancelledRef.current = false;
    let fetching = false;

    const doFetch = async () => {
      if (cancelledRef.current || fetching) return;
      fetching = true;
      await fetchDiff();
      fetching = false;
    };

    doFetch();

    // Quick check - only fetch if file content changed
    let lastHash = "";
    const quickCheck = async () => {
      if (cancelledRef.current || fetching) return;
      // Get fresh worktreeInfo inside callback to avoid stale closure
      const currentWorktreeInfo = getIssueWorktree(projectKey, issueKey);
      if (!currentWorktreeInfo) return;
      try {
        // Use hash-object to get actual file content hash (most accurate)
        const [statusOutput, fileHash, stagedHash] = await Promise.all([
          invoke<string>("run_git_command", {
            cwd: currentWorktreeInfo.path,
            args: ["status", "--porcelain", "--", file.path],
          }).catch(() => ""),
          invoke<string>("run_git_command", {
            cwd: currentWorktreeInfo.path,
            args: ["hash-object", file.path],
          }).catch(() => ""),
          invoke<string>("run_git_command", {
            cwd: currentWorktreeInfo.path,
            args: ["ls-files", "-s", "--", file.path],
          }).catch(() => ""),
        ]);

        const currentHash = statusOutput + fileHash + stagedHash;
        if (!cancelledRef.current && currentHash !== lastHash) {
          lastHash = currentHash;
          doFetch();
        }
      } catch {
        // Ignore errors
      }
    };

    // Use primitive value for interval condition
    const hasWorktree = !!worktreeInfo;
    const interval = hasWorktree ? setInterval(quickCheck, 1000) : null;
    return () => {
      cancelledRef.current = true;
      if (interval) clearInterval(interval);
    };
    // Use worktreeInfo?.path (primitive) instead of worktreeInfo (object)
  }, [fetchDiff, worktreeInfo?.path, file.path, projectKey, issueKey]);

  // Process hunks into sections with collapsible context regions
  const processedSections = useMemo(() => {
    if (hunks.length === 0) return [];

    const allLines = hunks.flatMap(h => h.lines);
    const sections: { type: 'change' | 'context'; lines: typeof allLines; startLine: number; endLine: number }[] = [];
    let currentSection: typeof sections[0] | null = null;

    for (const line of allLines) {
      const isChange = line.type === 'add' || line.type === 'del';
      const sectionType = isChange ? 'change' : 'context';

      if (!currentSection || currentSection.type !== sectionType) {
        if (currentSection) {
          currentSection.endLine = currentSection.lines[currentSection.lines.length - 1]?.newNum ||
                                   currentSection.lines[currentSection.lines.length - 1]?.oldNum || 0;
          sections.push(currentSection);
        }
        currentSection = {
          type: sectionType,
          lines: [line],
          startLine: line.newNum || line.oldNum || 0,
          endLine: 0
        };
      } else {
        currentSection.lines.push(line);
      }
    }

    if (currentSection) {
      currentSection.endLine = currentSection.lines[currentSection.lines.length - 1]?.newNum ||
                               currentSection.lines[currentSection.lines.length - 1]?.oldNum || 0;
      sections.push(currentSection);
    }

    return sections;
  }, [hunks]);

  const collapsibleIndices = processedSections
    .map((section, idx) => section.type === 'context' && section.lines.length > 6 ? idx : -1)
    .filter(idx => idx !== -1);

  const isAllExpanded = collapsibleIndices.length > 0 &&
    collapsibleIndices.every(idx => expandedGaps.has(idx));

  const toggleAllContexts = () => {
    if (isAllExpanded) {
      setExpandedGaps(new Set());
    } else {
      setExpandedGaps(new Set(collapsibleIndices));
    }
  };

  const renderLine = (line: DiffLine, lineIdx: number) => (
    <div key={lineIdx} className={`diff-line diff-line-${line.type}`}>
      <span className="diff-line-num">{line.newNum ?? line.oldNum ?? ''}</span>
      <span className="diff-line-code">
        <SyntaxHighlighter
          language={language}
          style={vscDarkPlus as { [key: string]: React.CSSProperties }}
          customStyle={{
            background: 'transparent',
            margin: 0,
            padding: 0,
            display: 'inline',
            fontSize: 'inherit',
            lineHeight: 'inherit',
          }}
          codeTagProps={{ style: { background: 'transparent' } }}
          PreTag="span"
          renderer={({ rows, stylesheet, useInlineStyles }) => {
            const renderText = (text: string, keyPrefix: string) => {
              const parts: React.ReactNode[] = [];
              const chars = Array.from(text); // Handle surrogate pairs (emojis)
              let buffer = '';
              let partIdx = 0;

              for (const char of chars) {
                if (char === ' ' || char === '\t') {
                  // Flush buffer as plain text
                  if (buffer) {
                    parts.push(buffer);
                    buffer = '';
                  }
                  // Whitespace: actual char with CSS visual indicator
                  parts.push(
                    <span
                      key={`${keyPrefix}-${partIdx++}`}
                      className={char === ' ' ? 'whitespace-space' : 'whitespace-tab'}
                    >
                      {char}
                    </span>
                  );
                } else {
                  buffer += char;
                }
              }
              // Flush remaining buffer
              if (buffer) {
                parts.push(buffer);
              }
              return parts;
            };
            return (
              <>
                {rows.map((row, i) => (
                  <span key={i}>
                    {row.children?.map((child, j) => {
                      if (child.type === 'text') {
                        const text = String(child.value || '');
                        return <span key={j}>{renderText(text, `${j}`)}</span>;
                      }
                      const style = useInlineStyles
                        ? child.properties?.style || (child.properties?.className?.reduce((acc: Record<string, string>, cls: string) => ({ ...acc, ...stylesheet[cls] }), {}) as React.CSSProperties)
                        : undefined;
                      const content = child.children?.map((c: { value?: string | number }) => String(c.value ?? '')).join('') || '';
                      return <span key={j} style={style}>{renderText(content, `${j}`)}</span>;
                    })}
                  </span>
                ))}
              </>
            );
          }}
        >
          {line.content || '\u00A0'}
        </SyntaxHighlighter>
      </span>
    </div>
  );

  // Default context lines to show around changes
  const CONTEXT_PREVIEW = 3;

  return (
    <div className="file-diff-viewer" tabIndex={0}>
      <div className="file-diff-header">
        <button className="file-diff-back" onClick={onBack} title="Back to issue">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polyline points="15 18 9 12 15 6" />
          </svg>
        </button>
        <span className="file-diff-status" style={{ color: `var(--status-${displayedFile.status === "A" ? "added" : displayedFile.status === "D" ? "deleted" : "modified"})` }}>
          {displayedFile.status}
        </span>
        <button
          className="file-diff-path-wrapper"
          onClick={(e) => {
            navigator.clipboard.writeText(displayedFile.path);
            const btn = e.currentTarget;
            btn.classList.add('copied');
            setTimeout(() => btn.classList.remove('copied'), 1000);
          }}
          title="Copy path"
        >
          <span className="file-diff-path">{displayedFile.path}</span>
          <svg className="copy-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="12" height="12">
            <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
          </svg>
          <svg className="check-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="12" height="12">
            <polyline points="20 6 9 17 4 12" />
          </svg>
        </button>
        {collapsibleIndices.length > 0 && (
          <button
            className="file-diff-action"
            onClick={toggleAllContexts}
            title={isAllExpanded ? "Collapse all" : "Expand all"}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
              {isAllExpanded ? (
                <>
                  <polyline points="4 14 10 14 10 20" />
                  <polyline points="20 10 14 10 14 4" />
                  <line x1="14" y1="10" x2="21" y2="3" />
                  <line x1="3" y1="21" x2="10" y2="14" />
                </>
              ) : (
                <>
                  <polyline points="15 3 21 3 21 9" />
                  <polyline points="9 21 3 21 3 15" />
                  <line x1="21" y1="3" x2="14" y2="10" />
                  <line x1="3" y1="21" x2="10" y2="14" />
                </>
              )}
            </svg>
          </button>
        )}
        <button
          className="file-diff-action"
          onClick={openInZed}
          disabled={displayedFile.status === "D"}
          title={displayedFile.status === "D" ? "File deleted" : "Open in Zed"}
          style={{ opacity: displayedFile.status === "D" ? 0.3 : undefined }}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
            <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
          </svg>
        </button>
      </div>
      <div className="file-diff-content" ref={contentRef}>
        {processedSections.length > 0 ? (
          <div className="diff-hunks">
            {modeChange && (
              <div className="diff-mode-change-banner">
                Mode changed: {modeChange.oldMode} → {modeChange.newMode}
              </div>
            )}
            {processedSections.map((section, sectionIdx) => {
              if (section.type === 'change') {
                // Group consecutive lines of same type within changes
                const groups: { type: string; lines: typeof section.lines }[] = [];
                for (const line of section.lines) {
                  const lastGroup = groups[groups.length - 1];
                  if (lastGroup && lastGroup.type === line.type) {
                    lastGroup.lines.push(line);
                  } else {
                    groups.push({ type: line.type, lines: [line] });
                  }
                }
                return (
                  <div key={sectionIdx} className="diff-hunk">
                    {groups.map((group, groupIdx) => (
                      <div key={groupIdx} className={`diff-group diff-group-${group.type}`}>
                        {group.lines.map((line, lineIdx) => renderLine(line, lineIdx))}
                      </div>
                    ))}
                  </div>
                );
              } else {
                // Context section - can be collapsed
                const isExpanded = expandedGaps.has(sectionIdx);
                const lineCount = section.lines.length;
                const canCollapse = lineCount > CONTEXT_PREVIEW * 2;

                if (!canCollapse) {
                  // Not enough lines to collapse - show all
                  return (
                    <div key={sectionIdx} className="diff-hunk">
                      <div className="diff-group diff-group-context">
                        {section.lines.map((line, lineIdx) => renderLine(line, lineIdx))}
                      </div>
                    </div>
                  );
                }

                // Collapsible section
                const topLines = section.lines.slice(0, CONTEXT_PREVIEW);
                const middleLines = section.lines.slice(CONTEXT_PREVIEW, -CONTEXT_PREVIEW);
                const bottomLines = section.lines.slice(-CONTEXT_PREVIEW);

                return (
                  <div key={sectionIdx} className="diff-hunk">
                    <div className="diff-group diff-group-context">
                      {topLines.map((line, lineIdx) => renderLine(line, lineIdx))}
                    </div>
                    <div className="diff-group-collapse">
                      <div className="diff-hunk-separator" onClick={() => toggleGap(sectionIdx)}>
                        <span className="diff-hunk-separator-gutter">{isExpanded ? '▲' : '▼'}</span>
                        <span className="diff-hunk-separator-text">
                          {isExpanded ? 'Collapse' : 'Expand'} {middleLines.length} lines
                        </span>
                      </div>
                      {isExpanded && middleLines.map((line, lineIdx) => renderLine(line, lineIdx + CONTEXT_PREVIEW))}
                    </div>
                    <div className="diff-group diff-group-context">
                      {bottomLines.map((line, lineIdx) => renderLine(line, lineIdx + topLines.length + (isExpanded ? middleLines.length : 0)))}
                    </div>
                  </div>
                );
              }
            })}
          </div>
        ) : modeChange ? (
          <div className="diff-hunks">
            <div className="diff-mode-change-banner">
              Mode changed: {modeChange.oldMode} → {modeChange.newMode}
            </div>
          </div>
        ) : (
          <div className="file-diff-empty">No changes</div>
        )}
      </div>
    </div>
  );
}

// Quick Memo Component
const DEFAULT_MEMO_SIZE = { width: 400, height: 300 };
const MIN_MEMO_SIZE = { width: 280, height: 150 };
const MAX_MEMO_SIZE = { width: 600, height: 500 };

function getMemoSize() {
  const saved = localStorage.getItem("quick_memo_size");
  if (saved) {
    try { return { ...DEFAULT_MEMO_SIZE, ...JSON.parse(saved) }; } catch { return DEFAULT_MEMO_SIZE; }
  }
  return DEFAULT_MEMO_SIZE;
}

function QuickMemo() {
  const connectionId = getActiveConnectionId();
  const [content, setContent] = useState(() => getMemo(connectionId));
  const [showPopover, setShowPopover] = useState(false);
  const [size, setSize] = useState(getMemoSize);
  const popoverRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const isDragging = useRef(false);
  const dragStart = useRef({ x: 0, y: 0, width: 0, height: 0 });
  const prevConnectionId = useRef(connectionId);

  // Reload memo when connection changes
  useEffect(() => {
    if (prevConnectionId.current !== connectionId) {
      setContent(getMemo(connectionId));
      prevConnectionId.current = connectionId;
    }
  }, [connectionId]);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (isDragging.current) return;
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        setShowPopover(false);
      }
    };
    if (showPopover) {
      document.addEventListener("mousedown", handleClickOutside);
      return () => document.removeEventListener("mousedown", handleClickOutside);
    }
  }, [showPopover]);

  useEffect(() => {
    if (showPopover && textareaRef.current) {
      textareaRef.current.focus();
    }
  }, [showPopover]);

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const newContent = e.target.value;
    setContent(newContent);
    saveMemo(connectionId, newContent);
  };

  const handleResizeStart = (e: React.MouseEvent) => {
    e.preventDefault();
    isDragging.current = true;
    dragStart.current = { x: e.clientX, y: e.clientY, width: size.width, height: size.height };
    let lastSize = { width: size.width, height: size.height };

    const handleMouseMove = (e: MouseEvent) => {
      if (!isDragging.current) return;
      const deltaX = e.clientX - dragStart.current.x;
      const deltaY = dragStart.current.y - e.clientY;
      const newWidth = Math.min(MAX_MEMO_SIZE.width, Math.max(MIN_MEMO_SIZE.width, dragStart.current.width + deltaX));
      const newHeight = Math.min(MAX_MEMO_SIZE.height, Math.max(MIN_MEMO_SIZE.height, dragStart.current.height + deltaY));
      lastSize = { width: newWidth, height: newHeight };
      setSize(lastSize);
    };

    const handleMouseUp = () => {
      isDragging.current = false;
      localStorage.setItem("quick_memo_size", JSON.stringify(lastSize));
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
  };

  return (
    <div className="quick-memo" ref={popoverRef}>
      <button
        className="quick-memo-badge"
        onClick={() => setShowPopover(!showPopover)}
      >
        <svg className="quick-memo-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <polyline points="14 2 14 8 20 8" />
          <line x1="16" y1="13" x2="8" y2="13" />
          <line x1="16" y1="17" x2="8" y2="17" />
        </svg>
      </button>
      {showPopover && (
        <div className="quick-memo-popover" style={{ width: size.width, height: size.height }}>
          <div className="quick-memo-resize-handle" onMouseDown={handleResizeStart} />
          <textarea
            ref={textareaRef}
            className="quick-memo-textarea"
            value={content}
            onChange={handleChange}
            placeholder="Memo..."
            spellCheck={false}
          />
        </div>
      )}
    </div>
  );
}

// System Stats Display Component
interface SystemStats {
  cpu_usage: number;
  memory_usage: number;
  temperature: number | null;
  network_rx: number;
  network_tx: number;
}

const CpuIcon = () => (
  <svg className="icon-xs" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="4" y="4" width="16" height="16" rx="2" />
    <rect x="9" y="9" width="6" height="6" />
    <path d="M9 1v3M15 1v3M9 20v3M15 20v3M20 9h3M20 14h3M1 9h3M1 14h3" />
  </svg>
);

const MemoryIcon = () => (
  <svg className="icon-xs" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="2" y="6" width="20" height="12" rx="2" />
    <path d="M6 6v-2M10 6v-2M14 6v-2M18 6v-2M6 18v2M10 18v2M14 18v2M18 18v2" />
  </svg>
);

const TempIcon = () => (
  <svg className="icon-xs" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M14 14.76V3.5a2.5 2.5 0 0 0-5 0v11.26a4.5 4.5 0 1 0 5 0z" />
  </svg>
);

const NetDownIcon = () => (
  <svg className="icon-xs" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 5v14M5 12l7 7 7-7" />
  </svg>
);

const NetUpIcon = () => (
  <svg className="icon-xs" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 19V5M5 12l7-7 7 7" />
  </svg>
);

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)}KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)}MB`;
  if (bytes < 1024 ** 4) return `${(bytes / 1024 ** 3).toFixed(1)}GB`;
  return `${(bytes / 1024 ** 4).toFixed(1)}TB`;
}

function SystemStatsDisplay() {
  const [stats, setStats] = useState<SystemStats | null>(null);

  useEffect(() => {
    let mounted = true;
    const poll = async () => {
      while (mounted) {
        try {
          const data = await invoke<SystemStats>("get_system_stats");
          if (mounted) setStats(data);
        } catch {}
        await new Promise(r => setTimeout(r, 2000));
      }
    };
    poll();
    return () => { mounted = false; };
  }, []);

  if (!stats) return null;

  const openActivityMonitor = () => {
    invoke("open_activity_monitor").catch(console.error);
  };

  return (
    <div className="system-stats" onClick={openActivityMonitor}>
      <span className="system-stat" title="CPU Usage">
        <CpuIcon />
        <span className="system-stat-value">{stats.cpu_usage.toFixed(0)}%</span>
      </span>
      <span className="system-stat" title="Memory Usage">
        <MemoryIcon />
        <span className="system-stat-value">{stats.memory_usage.toFixed(0)}%</span>
      </span>
      {stats.temperature != null && (
        <span className="system-stat" title="Temperature">
          <TempIcon />
          <span className="system-stat-value">{stats.temperature.toFixed(0)}°</span>
        </span>
      )}
      <span className="system-stat" title="Download">
        <NetDownIcon />
        <span className="system-stat-value network">{formatBytes(stats.network_rx)}/s</span>
      </span>
      <span className="system-stat" title="Upload">
        <NetUpIcon />
        <span className="system-stat-value network">{formatBytes(stats.network_tx)}/s</span>
      </span>
    </div>
  );
}

// Pomodoro Timer Component
function PomodoroTimer() {
  const [settings, setSettings] = useState<PomodoroSettings>(getPomodoroSettings);
  const [mode, setMode] = useState<PomodoroMode>("work");
  const [timeLeft, setTimeLeft] = useState(settings.workDuration * 60);
  const [isRunning, setIsRunning] = useState(false);
  const [sessionCount, setSessionCount] = useState(0);
  const [showPopover, setShowPopover] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [editSettings, setEditSettings] = useState<PomodoroSettings>(settings);
  const popoverRef = useRef<HTMLDivElement>(null);

  // Get duration for current mode
  const getDuration = useCallback((m: PomodoroMode, s: PomodoroSettings) => {
    switch (m) {
      case "work": return s.workDuration * 60;
      case "shortBreak": return s.shortBreakDuration * 60;
      case "longBreak": return s.longBreakDuration * 60;
    }
  }, []);

  // Timer logic
  useEffect(() => {
    if (!isRunning) return;

    const interval = setInterval(() => {
      setTimeLeft(prev => {
        if (prev <= 1) {
          // Timer completed
          if (settings.soundEnabled) {
            playNotificationSound();
          }

          // Determine next mode
          if (mode === "work") {
            const newSessionCount = sessionCount + 1;
            setSessionCount(newSessionCount);

            if (newSessionCount % settings.sessionsBeforeLongBreak === 0) {
              setMode("longBreak");
              return settings.longBreakDuration * 60;
            } else {
              setMode("shortBreak");
              return settings.shortBreakDuration * 60;
            }
          } else {
            // Break finished, back to work
            setMode("work");
            return settings.workDuration * 60;
          }
        }
        return prev - 1;
      });
    }, 1000);

    return () => clearInterval(interval);
  }, [isRunning, mode, sessionCount, settings]);

  // Close popover when clicking outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        setShowPopover(false);
        setShowSettings(false);
      }
    };

    if (showPopover) {
      document.addEventListener("mousedown", handleClickOutside);
      return () => document.removeEventListener("mousedown", handleClickOutside);
    }
  }, [showPopover]);

  const formatTime = (seconds: number) => {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
  };

  const toggleTimer = () => setIsRunning(!isRunning);

  const resetTimer = () => {
    setIsRunning(false);
    setTimeLeft(getDuration(mode, settings));
  };

  const skipToNext = () => {
    setIsRunning(false);
    if (mode === "work") {
      const newSessionCount = sessionCount + 1;
      setSessionCount(newSessionCount);
      if (newSessionCount % settings.sessionsBeforeLongBreak === 0) {
        setMode("longBreak");
        setTimeLeft(settings.longBreakDuration * 60);
      } else {
        setMode("shortBreak");
        setTimeLeft(settings.shortBreakDuration * 60);
      }
    } else {
      setMode("work");
      setTimeLeft(settings.workDuration * 60);
    }
  };

  const switchMode = (newMode: PomodoroMode) => {
    setMode(newMode);
    setTimeLeft(getDuration(newMode, settings));
    setIsRunning(false);
  };

  const saveSettings = () => {
    setSettings(editSettings);
    savePomodoroSettings(editSettings);
    setTimeLeft(getDuration(mode, editSettings));
    setShowSettings(false);
  };

  const resetAll = () => {
    setIsRunning(false);
    setMode("work");
    setTimeLeft(settings.workDuration * 60);
    setSessionCount(0);
  };

  const getModeLabel = () => {
    switch (mode) {
      case "work": return "Work";
      case "shortBreak": return "Break";
      case "longBreak": return "Long Break";
    }
  };

  const getModeColor = () => {
    switch (mode) {
      case "work": return "var(--error)";
      case "shortBreak": return "var(--success)";
      case "longBreak": return "var(--accent)";
    }
  };

  const progress = 1 - (timeLeft / getDuration(mode, settings));

  return (
    <div className="pomodoro-timer" ref={popoverRef}>
      <button
        className={`pomodoro-badge ${isRunning ? "running" : ""}`}
        onClick={() => setShowPopover(!showPopover)}
        style={isRunning ? { borderColor: getModeColor(), color: getModeColor() } : undefined}
      >
        <svg className="pomodoro-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="12" cy="12" r="10" />
          <polyline points="12 6 12 12 16 14" />
        </svg>
        <span className="pomodoro-time">{formatTime(timeLeft)}</span>
        {isRunning && (
          <span className="pomodoro-mode-indicator" style={{ background: getModeColor() }} />
        )}
      </button>

      {showPopover && (
        <div className="pomodoro-popover">
          {showSettings ? (
            <div className="pomodoro-settings">
              <div className="pomodoro-setting-row">
                <span>Work</span>
                <input type="number" min="1" max="120" value={editSettings.workDuration} onChange={e => setEditSettings({ ...editSettings, workDuration: parseInt(e.target.value) || 25 })} />
              </div>
              <div className="pomodoro-setting-row">
                <span>Short break</span>
                <input type="number" min="1" max="60" value={editSettings.shortBreakDuration} onChange={e => setEditSettings({ ...editSettings, shortBreakDuration: parseInt(e.target.value) || 5 })} />
              </div>
              <div className="pomodoro-setting-row">
                <span>Long break</span>
                <input type="number" min="1" max="60" value={editSettings.longBreakDuration} onChange={e => setEditSettings({ ...editSettings, longBreakDuration: parseInt(e.target.value) || 15 })} />
              </div>
              <div className="pomodoro-setting-row">
                <span>Long break after</span>
                <input type="number" min="1" max="10" value={editSettings.sessionsBeforeLongBreak} onChange={e => setEditSettings({ ...editSettings, sessionsBeforeLongBreak: parseInt(e.target.value) || 4 })} />
              </div>
              <div className="pomodoro-setting-row">
                <label><input type="checkbox" checked={editSettings.soundEnabled} onChange={e => setEditSettings({ ...editSettings, soundEnabled: e.target.checked })} />Sound</label>
                <button className="pomodoro-link-btn" onClick={playNotificationSound}>Test</button>
              </div>
              <div className="pomodoro-setting-actions">
                <button className="pomodoro-link-btn" onClick={() => setEditSettings(DEFAULT_POMODORO_SETTINGS)}>Reset</button>
                <div className="pomodoro-setting-btns">
                  <button className="pomodoro-text-btn" onClick={() => { setEditSettings(settings); setShowSettings(false); }}>Cancel</button>
                  <button className="pomodoro-text-btn primary" onClick={saveSettings}>Save</button>
                </div>
              </div>
            </div>
          ) : (
            <div className="pomodoro-main">
              <div className="pomodoro-ring" style={{ "--progress": progress, "--color": getModeColor() } as React.CSSProperties}>
                <svg viewBox="0 0 100 100">
                  <circle className="pomodoro-ring-bg" cx="50" cy="50" r="42" />
                  <circle className="pomodoro-ring-fill" cx="50" cy="50" r="42" />
                </svg>
                <div className="pomodoro-ring-content">
                  <div className="pomodoro-time-text">{formatTime(timeLeft)}</div>
                  <div className="pomodoro-mode-text" style={{ color: getModeColor() }}>{getModeLabel()}</div>
                </div>
              </div>
              <div className="pomodoro-tabs">
                <button className={mode === "work" ? "active" : ""} onClick={() => switchMode("work")}>Work</button>
                <button className={mode === "shortBreak" ? "active" : ""} onClick={() => switchMode("shortBreak")}>Break</button>
                <button className={mode === "longBreak" ? "active" : ""} onClick={() => switchMode("longBreak")}>Long</button>
              </div>
              <div className="pomodoro-btns">
                <button className="pomodoro-ctrl-btn" onClick={resetTimer} title="Reset">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" /><path d="M3 3v5h5" /></svg>
                </button>
                <button className="pomodoro-play-btn" onClick={toggleTimer}>
                  {isRunning ? (
                    <svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" rx="1" /><rect x="14" y="4" width="4" height="16" rx="1" /></svg>
                  ) : (
                    <svg viewBox="0 0 24 24" fill="currentColor"><polygon points="6 3 20 12 6 21" /></svg>
                  )}
                </button>
                <button className="pomodoro-ctrl-btn" onClick={skipToNext} title="Skip">
                  <svg viewBox="0 0 24 24" fill="currentColor"><polygon points="5 4 15 12 5 20" /><rect x="17" y="4" width="2" height="16" /></svg>
                </button>
              </div>
              <div className="pomodoro-footer">
                <span>#{sessionCount}</span>
                <div className="pomodoro-footer-btns">
                  {sessionCount > 0 && <button className="pomodoro-link-btn" onClick={resetAll}>Reset</button>}
                  <button className="pomodoro-link-btn" onClick={() => { setEditSettings(settings); setShowSettings(true); }}>Settings</button>
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// PR Type (shared)
type GitHubPR = {
  number: number;
  title: string;
  url: string;
  repository: { nameWithOwner: string };
  author: { login: string };
  createdAt: string;
  updatedAt: string;
  headRefName?: string;
  baseRefName?: string;
  reviewDecision?: string;
};

// PR Data Context - Single GraphQL query for both MyPRs and ReviewRequestedPRs
type PRDataContextType = {
  myPRs: GitHubPR[];
  reviewRequestedPRs: GitHubPR[];
  loading: boolean;
  error: string | null;
  refresh: (showCheckOnSuccess?: boolean) => void;
  showCheck: boolean;
  setShowCheck: (v: boolean) => void;
};

const PRDataContext = createContext<PRDataContextType | null>(null);

function PRDataProvider({ children }: { children: React.ReactNode }) {
  const [myPRs, setMyPRs] = useState<GitHubPR[]>([]);
  const [reviewRequestedPRs, setReviewRequestedPRs] = useState<GitHubPR[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showCheck, setShowCheck] = useState(false);
  const fetchIdRef = useRef(0);

  const fetchPRs = useCallback(async (showCheckOnSuccess = false) => {
    const fetchId = ++fetchIdRef.current;
    setLoading(true);
    setShowCheck(false);
    try {
      const homeDir: string = await invoke("get_home_dir");
      const query = `{
        myPRs: search(query: "is:pr is:open author:@me archived:false", type: ISSUE, first: 30) {
          nodes {
            ... on PullRequest {
              number
              title
              url
              repository { nameWithOwner }
              author { login }
              createdAt
              updatedAt
              headRefName
              baseRefName
              reviewDecision

            }
          }
        }
        reviewRequested: search(query: "is:pr is:open review-requested:@me archived:false", type: ISSUE, first: 30) {
          nodes {
            ... on PullRequest {
              number
              title
              url
              repository { nameWithOwner }
              author { login }
              createdAt
              updatedAt
              headRefName
              baseRefName
              reviewDecision

            }
          }
        }
      }`;
      const result: string = await invoke("run_gh_command", {
        cwd: homeDir,
        args: ["api", "graphql", "-f", `query=${query}`]
      });
      if (fetchId !== fetchIdRef.current) return;
      const data = JSON.parse(result);
      const transformNodes = (nodes: unknown[]): GitHubPR[] =>
        nodes.filter((n): n is GitHubPR => n !== null && typeof n === "object" && "number" in n).map(n => ({
          ...n,
          reviewDecision: (n as Record<string, unknown>).reviewDecision as string || '',
        }));
      setMyPRs(transformNodes(data?.data?.myPRs?.nodes || []));
      setReviewRequestedPRs(transformNodes(data?.data?.reviewRequested?.nodes || []));
      setError(null);
      if (showCheckOnSuccess) setShowCheck(true);
    } catch (e) {
      if (fetchId !== fetchIdRef.current) return;
      const errStr = String(e);
      if (errStr.includes("gh auth login") || errStr.includes("not logged")) {
        setError("gh CLI not authenticated. Run 'gh auth login' in terminal.");
      } else if (errStr.includes("command not found") || errStr.includes("Failed to execute gh")) {
        setError("gh CLI not installed. Install from https://cli.github.com");
      } else {
        setError(errStr.length > 100 ? errStr.slice(0, 100) + "..." : errStr);
      }
    } finally {
      if (fetchId === fetchIdRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchPRs(false);
    const interval = setInterval(() => fetchPRs(false), 5 * 60 * 1000);
    return () => clearInterval(interval);
  }, [fetchPRs]);

  const value = useMemo(() => ({
    myPRs,
    reviewRequestedPRs,
    loading,
    error,
    refresh: fetchPRs,
    showCheck,
    setShowCheck,
  }), [myPRs, reviewRequestedPRs, loading, error, fetchPRs, showCheck]);

  return <PRDataContext.Provider value={value}>{children}</PRDataContext.Provider>;
}

function usePRData() {
  const ctx = useContext(PRDataContext);
  if (!ctx) throw new Error("usePRData must be used within PRDataProvider");
  return ctx;
}

// Shared helpers
function formatTimeAgo(date: Date | string | undefined | null) {
  if (!date) return "";
  const d = typeof date === "string" ? new Date(date) : date;
  if (isNaN(d.getTime())) return "";
  const now = new Date();
  const diff = now.getTime() - d.getTime();
  const days = Math.floor(diff / (1000 * 60 * 60 * 24));
  const hours = Math.floor(diff / (1000 * 60 * 60));
  const minutes = Math.floor(diff / (1000 * 60));
  if (days > 0) return `${days}d ago`;
  if (hours > 0) return `${hours}h ago`;
  if (minutes > 0) return `${minutes}m ago`;
  return "just now";
}

// My PRs Component
function MyPRs() {
  const { myPRs: prs, loading, error, refresh, showCheck, setShowCheck } = usePRData();
  const [showPopover, setShowPopover] = useState(false);
  const popoverRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!showPopover) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        setShowPopover(false);
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setShowPopover(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [showPopover]);

  return (
    <div className="my-prs" ref={popoverRef}>
      <button
        className={`my-prs-badge ${prs.length > 0 ? "has-prs" : ""}`}
        onClick={() => setShowPopover(!showPopover)}
        title={`${prs.length} open PR${prs.length !== 1 ? "s" : ""} by you`}
      >
        <svg className="my-prs-icon" viewBox="0 0 16 16" fill="currentColor" style={{ transform: "scaleX(-1)" }}>
          <path d="M1.5 3.25a2.25 2.25 0 1 1 3 2.122v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.25 2.25 0 0 1 1.5 3.25Zm5.677-.177L9.573.677A.25.25 0 0 1 10 .854V2.5h1A2.5 2.5 0 0 1 13.5 5v5.628a2.251 2.251 0 1 1-1.5 0V5a1 1 0 0 0-1-1h-1v1.646a.25.25 0 0 1-.427.177L7.177 3.427a.25.25 0 0 1 0-.354ZM3.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm0 9.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm8.25.75a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Z"/>
        </svg>
        {prs.length > 0 && <span className="my-prs-count">{prs.length}</span>}
      </button>
      {showPopover && (
        <div className={`my-prs-popover ${loading ? "loading" : ""}`}>
          <div className="my-prs-header">
            <span>My Pull Requests</span>
            <button className="my-prs-refresh" onClick={() => refresh(true)} disabled={loading} title="Refresh">
              {showCheck ? (
                <svg className="my-prs-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" onAnimationEnd={() => setShowCheck(false)}>
                  <path d="M20 6L9 17l-5-5" />
                </svg>
              ) : loading ? (
                <span className="my-prs-dots">
                  <span className="dot" />
                  <span className="dot" />
                  <span className="dot" />
                </span>
              ) : (
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                  <path d="M3 3v5h5" />
                </svg>
              )}
            </button>
          </div>
          <div className="my-prs-list">
            {error ? (
              <div className="my-prs-error">{error}</div>
            ) : loading && prs.length === 0 ? (
              <div className="my-prs-empty">Loading...</div>
            ) : prs.length === 0 ? (
              <div className="my-prs-empty">No open PRs</div>
            ) : (
              prs.map((pr) => (
                <button
                  key={`${pr.repository?.nameWithOwner || "unknown"}-${pr.number}`}
                  className="my-pr-item"
                  onClick={() => pr.url && openUrl(pr.url)}
                >
                  {pr.headRefName && pr.baseRefName && (
                    <div className="my-pr-branch-info">{pr.headRefName} → {pr.baseRefName}</div>
                  )}
                  <div className="my-pr-title">
                    <span className="my-pr-number">#{pr.number}</span>
                    {pr.title || "Untitled"}
                    {pr.reviewDecision && (
                      <span className={`my-pr-review ${pr.reviewDecision === 'APPROVED' ? 'approved' : pr.reviewDecision === 'CHANGES_REQUESTED' ? 'changes' : 'pending'}`} title={pr.reviewDecision === 'APPROVED' ? 'Approved' : pr.reviewDecision === 'CHANGES_REQUESTED' ? 'Changes requested' : 'Review required'}>
                        {pr.reviewDecision === 'APPROVED' ? (
                          <svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="20 6 9 17 4 12" /></svg>
                        ) : pr.reviewDecision === 'CHANGES_REQUESTED' ? (
                          <svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" /><path d="M18.5 2.5a2.12 2.12 0 013 3L12 15l-4 1 1-4 9.5-9.5z" /></svg>
                        ) : (
                          <svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" /><circle cx="12" cy="12" r="3" /></svg>
                        )}
                      </span>
                    )}
                  </div>
                  <div className="my-pr-meta">
                    <span className="my-pr-repo">{pr.repository?.nameWithOwner || "unknown"}</span>
                    {pr.updatedAt && <span className="my-pr-time">{formatTimeAgo(pr.updatedAt)}</span>}
                  </div>
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// Review Requested PRs Component
function ReviewRequestedPRs() {
  const { reviewRequestedPRs: prs, loading, error, refresh, showCheck, setShowCheck } = usePRData();
  const [showPopover, setShowPopover] = useState(false);
  const popoverRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!showPopover) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        setShowPopover(false);
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setShowPopover(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [showPopover]);

  return (
    <div className="review-prs" ref={popoverRef}>
      <button
        className={`review-prs-badge ${prs.length > 0 ? "has-prs" : ""}`}
        onClick={() => setShowPopover(!showPopover)}
        title={`${prs.length} PR${prs.length !== 1 ? "s" : ""} awaiting your review`}
      >
        <svg className="review-prs-icon" viewBox="0 0 16 16" fill="currentColor">
          <path d="M1.5 3.25a2.25 2.25 0 1 1 3 2.122v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.25 2.25 0 0 1 1.5 3.25Zm5.677-.177L9.573.677A.25.25 0 0 1 10 .854V2.5h1A2.5 2.5 0 0 1 13.5 5v5.628a2.251 2.251 0 1 1-1.5 0V5a1 1 0 0 0-1-1h-1v1.646a.25.25 0 0 1-.427.177L7.177 3.427a.25.25 0 0 1 0-.354ZM3.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm0 9.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm8.25.75a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Z"/>
        </svg>
        {prs.length > 0 && <span className="review-prs-count">{prs.length}</span>}
      </button>
      {showPopover && (
        <div className={`review-prs-popover ${loading ? "loading" : ""}`}>
          <div className="review-prs-header">
            <span>Review Requested</span>
            <button className="review-prs-refresh" onClick={() => refresh(true)} disabled={loading} title="Refresh">
              {showCheck ? (
                <svg className="review-prs-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" onAnimationEnd={() => setShowCheck(false)}>
                  <path d="M20 6L9 17l-5-5" />
                </svg>
              ) : loading ? (
                <span className="review-prs-dots">
                  <span className="dot" />
                  <span className="dot" />
                  <span className="dot" />
                </span>
              ) : (
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                  <path d="M3 3v5h5" />
                </svg>
              )}
            </button>
          </div>
          <div className="review-prs-list">
            {error ? (
              <div className="review-prs-error">{error}</div>
            ) : loading && prs.length === 0 ? (
              <div className="review-prs-empty">Loading...</div>
            ) : prs.length === 0 ? (
              <div className="review-prs-empty">No PRs awaiting review</div>
            ) : (
              prs.map((pr) => (
                <button
                  key={`${pr.repository?.nameWithOwner || "unknown"}-${pr.number}`}
                  className="review-pr-item"
                  onClick={() => pr.url && openUrl(pr.url)}
                >
                  {pr.headRefName && pr.baseRefName && (
                    <div className="review-pr-branch-info">{pr.headRefName} → {pr.baseRefName}</div>
                  )}
                  <div className="review-pr-title">
                    <span className="review-pr-number">#{pr.number}</span>
                    {pr.title || "Untitled"}
                  </div>
                  <div className="review-pr-meta">
                    <span className="review-pr-repo">{pr.repository?.nameWithOwner || "unknown"}</span>
                    {pr.author?.login && <span className="review-pr-author">by {pr.author.login}</span>}
                    {pr.updatedAt && <span className="review-pr-time">{formatTimeAgo(pr.updatedAt)}</span>}
                  </div>
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function MainApp({ onLogout }: { onLogout: () => void }) {
  const [sidebarWidth, setSidebarWidthState] = useState(() => {
    const saved = localStorage.getItem("left_sidebar_width");
    return saved !== null ? parseInt(saved, 10) : 400;
  });
  const setSidebarWidth = (width: number) => {
    setSidebarWidthState(width);
    localStorage.setItem("left_sidebar_width", String(width));
  };
  const [sidebarCollapsed, setSidebarCollapsedState] = useState(() => {
    const saved = localStorage.getItem("left_sidebar_collapsed");
    return saved !== null ? saved === "true" : false;
  });
  const [rightSidebarWidth, setRightSidebarWidthState] = useState(() => {
    const saved = localStorage.getItem("right_sidebar_width");
    return saved !== null ? parseInt(saved, 10) : 400;
  });
  const setRightSidebarWidth = (width: number) => {
    setRightSidebarWidthState(width);
    localStorage.setItem("right_sidebar_width", String(width));
  };
  const [rightSidebarCollapsed, setRightSidebarCollapsedState] = useState(() => {
    const saved = localStorage.getItem("right_sidebar_collapsed");
    return saved !== null ? saved === "true" : true;
  });

  const setSidebarCollapsed = (value: boolean | ((prev: boolean) => boolean)) => {
    setSidebarCollapsedState(prev => {
      const next = typeof value === "function" ? value(prev) : value;
      localStorage.setItem("left_sidebar_collapsed", String(next));
      return next;
    });
  };

  const setRightSidebarCollapsed = (value: boolean | ((prev: boolean) => boolean)) => {
    setRightSidebarCollapsedState(prev => {
      const next = typeof value === "function" ? value(prev) : value;
      localStorage.setItem("right_sidebar_collapsed", String(next));
      return next;
    });
  };
  const [diffFilesCount, setDiffFilesCount] = useState(0);
  const [selectedDiffFile, setSelectedDiffFile] = useState<DiffFile | null>(() => {
    // Restore from per-issue storage if available
    return null;
  });
  const [isResizing, setIsResizing] = useState<'left' | 'right' | false>(false);
  const [settingsProject, setSettingsProject] = useState<string | null>(null);
  const [selectedIssue, setSelectedIssue] = useState<string | null>(null);
  const [refreshTrigger, setRefreshTrigger] = useState(0);
  const [terminalCollapsed, setTerminalCollapsedState] = useState(() => {
    const saved = localStorage.getItem("terminal_collapsed");
    return saved !== null ? saved === "true" : false;
  });
  const [terminalMaximized, setTerminalMaximizedState] = useState(() => {
    const saved = localStorage.getItem("terminal_maximized");
    return saved !== null ? saved === "true" : false;
  });

  const setTerminalCollapsed = (value: boolean | ((prev: boolean) => boolean)) => {
    setTerminalCollapsedState(prev => {
      const next = typeof value === "function" ? value(prev) : value;
      localStorage.setItem("terminal_collapsed", String(next));
      return next;
    });
  };

  const setTerminalMaximized = (value: boolean | ((prev: boolean) => boolean)) => {
    setTerminalMaximizedState(prev => {
      const next = typeof value === "function" ? value(prev) : value;
      localStorage.setItem("terminal_maximized", String(next));
      return next;
    });
  };
  const [hiddenProjects, setHiddenProjectsState] = useState<string[]>(getHiddenProjects());
  const [pinnedIssues, setPinnedIssuesState] = useState<string[]>(() => {
    const saved = localStorage.getItem(`${getStoragePrefix()}pinned_issues`);
    return saved ? JSON.parse(saved) : [];
  });
  const [showHiddenPanel, setShowHiddenPanel] = useState(false);
  const [createProject, setCreateProject] = useState<string | null>(null);
  const [createParent, setCreateParent] = useState<string | null>(null);
  const [issueRefreshTrigger, setIssueRefreshTrigger] = useState(0);
  const [showGlobalSettings, setShowGlobalSettingsState] = useState(() => {
    return sessionStorage.getItem("show_global_settings") === "true";
  });
  const setShowGlobalSettings = (value: boolean) => {
    setShowGlobalSettingsState(value);
    if (value) {
      sessionStorage.setItem("show_global_settings", "true");
    } else {
      sessionStorage.removeItem("show_global_settings");
    }
  };
  const [deletingWorktreeKeys, setDeletingWorktreeKeys] = useState<Set<string>>(new Set());
  const [visibleIssueKeys, setVisibleIssueKeys] = useState<Set<string>>(new Set());

  // Load saved theme on mount
  useEffect(() => {
    const loadSavedTheme = async () => {
      const themeName = getCurrentThemeName();
      if (themeName === DEFAULT_THEME_NAME) {
        applyTheme(null);
        return;
      }

      try {
        const files = await listThemeFiles();
        const themesDir = await getThemesDir();

        for (const file of files) {
          const theme = await loadThemeFromFile(themesDir, file);
          if (theme && theme.name === themeName) {
            applyTheme(theme);
            return;
          }
        }

        // Theme not found, reset to default
        saveCurrentThemeName(DEFAULT_THEME_NAME);
        applyTheme(null);
      } catch (e) {
        console.error("Failed to load saved theme:", e);
      }
    };

    loadSavedTheme();
  }, []);

  // Toggle sidebar shortcut
  useEffect(() => {
    const shortcuts = getShortcuts();
    const handleKeyDown = (e: KeyboardEvent) => {
      if (matchesShortcut(e, shortcuts.toggleSidebar)) {
        e.preventDefault();
        setSidebarCollapsed(prev => !prev);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  // Toggle right sidebar shortcut
  useEffect(() => {
    const shortcuts = getShortcuts();
    const handleKeyDown = (e: KeyboardEvent) => {
      if (matchesShortcut(e, shortcuts.toggleRightSidebar)) {
        e.preventDefault();
        setRightSidebarCollapsed(prev => !prev);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  // Toggle terminal shortcut
  useEffect(() => {
    const shortcuts = getShortcuts();
    const handleKeyDown = (e: KeyboardEvent) => {
      if (matchesShortcut(e, shortcuts.toggleTerminal)) {
        e.preventDefault();
        setTerminalCollapsed(prev => !prev);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  // Maximize terminal shortcut
  useEffect(() => {
    const shortcuts = getShortcuts();
    const handleKeyDown = (e: KeyboardEvent) => {
      if (matchesShortcut(e, shortcuts.maximizeTerminal)) {
        e.preventDefault();
        if (terminalCollapsed) {
          setTerminalCollapsed(false);
          setTerminalMaximized(true);
        } else {
          setTerminalMaximized(prev => !prev);
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [terminalCollapsed]);

  // Close diff file with CMD+W
  useEffect(() => {
    const shortcuts = getShortcuts();
    const handleKeyDown = (e: KeyboardEvent) => {
      if (matchesShortcut(e, shortcuts.closeTerminalTab)) {
        const diffViewer = document.querySelector('.file-diff-viewer');
        const isDiffFocused = diffViewer?.contains(document.activeElement) || document.activeElement?.closest('.file-diff-viewer');
        if (isDiffFocused && selectedDiffFile) {
          e.preventDefault();
          setSelectedDiffFile(null);
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [selectedDiffFile]);

  // Auto polling
  useEffect(() => {
    const interval = setInterval(() => {
      setRefreshTrigger(n => n + 1);
      setIssueRefreshTrigger(n => n + 1);
    }, POLL_INTERVAL);
    return () => clearInterval(interval);
  }, []);

  const hideProject = (projectKey: string) => {
    const updated = [...hiddenProjects, projectKey];
    setHiddenProjects(updated);
    setHiddenProjectsState(updated);
  };

  const unhideProject = (projectKey: string) => {
    const updated = hiddenProjects.filter(k => k !== projectKey);
    setHiddenProjects(updated);
    setHiddenProjectsState(updated);
  };

  const togglePinIssue = (issueKey: string) => {
    const updated = pinnedIssues.includes(issueKey)
      ? pinnedIssues.filter(k => k !== issueKey)
      : [...pinnedIssues, issueKey];
    setPinnedIssuesState(updated);
    localStorage.setItem(`${getStoragePrefix()}pinned_issues`, JSON.stringify(updated));
  };

  const startResizing = useCallback(() => setIsResizing('left'), []);
  const startResizingRight = useCallback(() => setIsResizing('right'), []);
  const stopResizing = useCallback(() => setIsResizing(false), []);

  const resize = useCallback(
    (e: React.MouseEvent) => {
      if (isResizing === 'left') {
        const newWidth = e.clientX;
        if (newWidth >= 120 && newWidth <= 600) {
          setSidebarWidth(newWidth);
        }
      } else if (isResizing === 'right') {
        const newWidth = window.innerWidth - e.clientX;
        if (newWidth >= 120 && newWidth <= 600) {
          setRightSidebarWidth(newWidth);
        }
      }
    },
    [isResizing]
  );

  const handleSaveFilter = () => {
    setRefreshTrigger((n) => n + 1);
    setSettingsProject(null);
  };

  const handleIssueClick = (issueKey: string) => {
    // Close diff viewer when switching issues
    setSelectedDiffFile(null);
    setSelectedIssue(issueKey);
    setSettingsProject(null);
    setCreateProject(null);
    setShowGlobalSettings(false);
    setTerminalMaximized(false);
  };

  const handleSettingsClick = (projectKey: string) => {
    setSettingsProject(projectKey);
    setSelectedIssue(null);
    setCreateProject(null);
    setShowGlobalSettings(false);
  };

  const handleCreateClick = (projectKey: string) => {
    setCreateProject(projectKey);
    setCreateParent(null);
    setSettingsProject(null);
    setSelectedIssue(null);
    setShowGlobalSettings(false);
  };

  const handleCreateChild = (projectKey: string, parentKey: string) => {
    setCreateProject(projectKey);
    setCreateParent(parentKey);
    setSettingsProject(null);
    setSelectedIssue(null);
    setShowGlobalSettings(false);
  };

  const handleIssueCreated = (issueKey: string) => {
    setRefreshTrigger((n) => n + 1);
    setCreateProject(null);
    setCreateParent(null);
    setSelectedIssue(issueKey);
  };

  return (
    <div className="app-container">
      <div className="titlebar-drag-region" onMouseDown={() => getCurrentWindow().startDragging()} onDoubleClick={() => getCurrentWindow().toggleMaximize()} />
      <div
        className={`app ${isResizing ? 'resizing' : ''}`}
        onMouseMove={resize}
        onMouseUp={stopResizing}
        onMouseLeave={stopResizing}
        onDragStart={(e) => e.preventDefault()}
      >
        <div className="sidebar scrollable" style={{ width: sidebarCollapsed ? 0 : sidebarWidth, display: sidebarCollapsed ? 'none' : undefined }} onMouseDown={() => (document.activeElement as HTMLElement)?.blur?.()}>
          <div className="sidebar-toggle-row">
            <button className="sidebar-toggle" onClick={() => setSidebarCollapsed(true)} title="Hide sidebar (Cmd+B)">
              <svg className="icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <rect x="3" y="3" width="18" height="18" rx="2"/>
                <line x1="9" y1="3" x2="9" y2="21"/>
              </svg>
            </button>
          </div>
          <div className="sidebar-header">
            <span>Projects</span>
            {hiddenProjects.length > 0 ? (
              <button
                className="hidden-toggle"
                onClick={() => setShowHiddenPanel(!showHiddenPanel)}
                title="Show hidden projects"
              >
                {hiddenProjects.length} hidden
              </button>
            ) : (
              <span className="hidden-toggle-placeholder"></span>
            )}
          </div>
          {showHiddenPanel && hiddenProjects.length > 0 && (
            <div className="hidden-panel">
              {hiddenProjects.map(key => (
                <div key={key} className="hidden-item">
                  <span>{key}</span>
                  <button className="unhide-btn" onClick={() => unhideProject(key)}>Show</button>
                </div>
              ))}
            </div>
          )}
          <ProjectTree
            onSettingsClick={handleSettingsClick}
            onRefresh={refreshTrigger}
            hiddenProjects={hiddenProjects}
            onHideProject={hideProject}
            onIssueClick={handleIssueClick}
            selectedIssue={selectedIssue}
            onCreateClick={handleCreateClick}
            pinnedIssues={pinnedIssues}
            onPinToggle={togglePinIssue}
            onIssuesChange={setVisibleIssueKeys}
          />
      </div>
      {sidebarCollapsed && (
        <button className="sidebar-expand" onClick={() => setSidebarCollapsed(false)} title="Show sidebar (Cmd+B)">
          <svg className="icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="3" y="3" width="18" height="18" rx="2"/>
            <line x1="9" y1="3" x2="9" y2="21"/>
          </svg>
        </button>
      )}
      {!sidebarCollapsed && <div className="resize-handle" onMouseDown={startResizing} />}
      <div className="main-content">
        {showGlobalSettings ? (
          <GlobalSettings onLogout={onLogout} deletingWorktreeKeys={deletingWorktreeKeys} setDeletingWorktreeKeys={setDeletingWorktreeKeys} visibleIssueKeys={visibleIssueKeys} />
        ) : settingsProject ? (
          <FilterSettings projectKey={settingsProject} onSave={handleSaveFilter} />
        ) : createProject ? (
          <CreateIssueForm
            projectKey={createProject}
            parentKey={createParent || undefined}
            onCreated={handleIssueCreated}
            onCancel={() => {
              if (createParent) setSelectedIssue(createParent);
              setCreateProject(null);
              setCreateParent(null);
            }}
          />
        ) : selectedIssue ? (
          <div className="issue-detail-container">
            {selectedDiffFile ? (
              <FileDiffViewer
                issueKey={selectedIssue}
                file={selectedDiffFile}
                onBack={() => {
                  setSelectedDiffFile(null);
                }}
              />
            ) : (
              <IssueDetailView issueKey={selectedIssue} onIssueClick={handleIssueClick} onCreateChild={handleCreateChild} onRefresh={() => setRefreshTrigger(n => n + 1)} refreshTrigger={issueRefreshTrigger} terminalCollapsed={terminalCollapsed} setTerminalCollapsed={setTerminalCollapsed} terminalMaximized={terminalMaximized} setTerminalMaximized={setTerminalMaximized} renderTerminal={false} />
            )}
            <TerminalPanel issueKey={selectedIssue} projectKey={getProjectKeyFromIssueKey(selectedIssue)} isCollapsed={terminalCollapsed} setIsCollapsed={setTerminalCollapsed} isMaximized={terminalMaximized} setIsMaximized={setTerminalMaximized} onWorktreeChange={() => setRefreshTrigger(n => n + 1)} />
          </div>
        ) : (
          <div className="empty-detail">
            <div className="empty-detail-content">
              <div className="empty-detail-name">{__APP_NAME__}</div>
              <div className="empty-detail-version">v{__APP_VERSION__}</div>
            </div>
          </div>
        )}
      </div>
      <div className="sidebar right-sidebar scrollable" style={{ width: rightSidebarCollapsed ? 0 : rightSidebarWidth, display: rightSidebarCollapsed ? 'none' : undefined }} onMouseDown={() => (document.activeElement as HTMLElement)?.blur?.()}>
        <div className="resize-handle resize-handle-right" onMouseDown={startResizingRight} />
        <div className="right-sidebar-inner">
          <div className="sidebar-header">
            <button className="sidebar-toggle" onClick={() => setRightSidebarCollapsed(true)} title="Hide right sidebar (Cmd+Option+B)">
              <svg className="icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <rect x="3" y="3" width="18" height="18" rx="2"/>
                <line x1="15" y1="3" x2="15" y2="21"/>
              </svg>
            </button>
            <span>
              {diffFilesCount > 0 ? `${diffFilesCount} Changes` : 'Changes'}
            </span>
          </div>
          <div className="right-sidebar-content">
            <DiffFileTree
              issueKey={selectedIssue}
              onFilesCountChange={setDiffFilesCount}
              onFileSelect={(file) => { setSelectedDiffFile(file); setTerminalMaximized(false); }}
              selectedFile={selectedDiffFile?.path}
              refreshTrigger={refreshTrigger}
            />
          </div>
        </div>
      </div>
      {rightSidebarCollapsed && (
        <button className="sidebar-expand sidebar-expand-right" onClick={() => setRightSidebarCollapsed(false)} title="Show right sidebar (Cmd+Option+B)">
          <svg className="icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="3" y="3" width="18" height="18" rx="2"/>
            <line x1="15" y1="3" x2="15" y2="21"/>
          </svg>
        </button>
      )}
    </div>
    <div className="status-bar">
      <div className="status-bar-left">
        <PomodoroTimer />
        <QuickMemo />
        <PRDataProvider>
          <ReviewRequestedPRs />
          <MyPRs />
        </PRDataProvider>
      </div>
      <div className="status-bar-right">
        <SystemStatsDisplay />
        <button className="status-bar-btn" onClick={() => {
          setShowGlobalSettings(true);
                setSettingsProject(null);
          setCreateProject(null);
          setSelectedIssue(null);
        }} title="Settings">
          <GearIcon />
        </button>
      </div>
    </div>
  </div>
  );
}

function App() {
  const [isSetupComplete, setIsSetupComplete] = useState<boolean | null>(null);

  useEffect(() => {
    const connections = getJiraConnections();
    setIsSetupComplete(connections.length > 0);
  }, []);

  if (isSetupComplete === null) {
    return null;
  }

  if (!isSetupComplete) {
    return <Setup onComplete={() => setIsSetupComplete(true)} />;
  }

  return <MainApp onLogout={() => setIsSetupComplete(false)} />;
}

export default App;
