import { useState, useCallback, useEffect, useRef, Fragment } from "react";
import { fetch } from "@tauri-apps/plugin-http";
import { openUrl } from "@tauri-apps/plugin-opener";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
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
  issueType: string;
  projectKey: string;
  comments: Comment[];
  parentKey: string | null;
  parentSummary: string | null;
  timeTracking: TimeTracking | null;
  worklogs: Worklog[];
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

type JiraConnection = {
  id: string;
  name: string;
  username: string;
  token: string;
  baseUrl: string;
};

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

function getProjectRepoPath(projectKey: string): string {
  return localStorage.getItem(`${getStoragePrefix()}repo_path_${projectKey}`) || "";
}

function saveProjectRepoPath(projectKey: string, path: string) {
  const key = `${getStoragePrefix()}repo_path_${projectKey}`;
  if (path) {
    localStorage.setItem(key, path);
  } else {
    localStorage.removeItem(key);
  }
}

function getProjectKeyFromIssueKey(issueKey: string): string {
  return issueKey.split("-")[0] || "";
}

type WorktreeInfo = {
  path: string;
  branch: string;
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
type ShortcutKey = "toggleSidebar" | "toggleTerminal" | "newTerminalTab" | "newTerminalGroup";

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
  toggleTerminal: { key: "j", meta: true, ctrl: false, shift: false, alt: false },
  newTerminalTab: { key: "t", meta: true, ctrl: false, shift: false, alt: false },
  newTerminalGroup: { key: "\\", meta: true, ctrl: false, shift: false, alt: false },
};

const SHORTCUT_LABELS: Record<ShortcutKey, string> = {
  toggleSidebar: "Toggle Sidebar",
  toggleTerminal: "Toggle Terminal",
  newTerminalTab: "New Terminal Tab",
  newTerminalGroup: "New Terminal Group",
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

function matchesShortcut(e: KeyboardEvent, shortcut: Shortcut): boolean {
  const keyMatches = e.key.toLowerCase() === shortcut.key.toLowerCase() ||
    (shortcut.key === "=" && (e.key === "=" || e.key === "+"));
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
  console.log("JQL:", jql);
  const url = `${getBaseUrl()}/rest/api/3/search/jql?jql=${encodeURIComponent(jql)}&fields=summary,priority,issuetype,status&maxResults=${filter.maxResults}`;
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
  }));
}

async function fetchIssueDetail(issueKey: string): Promise<IssueDetail> {
  const url = `${getBaseUrl()}/rest/api/3/issue/${issueKey}?fields=summary,description,status,priority,assignee,reporter,created,updated,labels,issuetype,comment,project,parent,timetracking,worklog`;
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
    issueType: data.fields.issuetype?.name || "",
    projectKey: data.fields.project?.key || issueKey.split("-")[0],
    comments,
    parentKey: data.fields.parent?.key || null,
    parentSummary: data.fields.parent?.fields?.summary || null,
    timeTracking,
    worklogs,
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
  // adjustEstimate=leave: don't change remaining estimate
  const res = await fetch(`${getBaseUrl()}/rest/api/3/issue/${issueKey}/worklog?adjustEstimate=leave`, {
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

  console.log("ADF:", JSON.stringify(desc, null, 2));

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
}: {
  onSettingsClick: (projectKey: string) => void;
  onRefresh: number;
  hiddenProjects: string[];
  onHideProject: (projectKey: string) => void;
  onIssueClick: (issueKey: string) => void;
  selectedIssue: string | null;
  onCreateClick: (projectKey: string) => void;
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
              {projectIssues[project.key].map((issue) => (
                <div
                  key={issue.id}
                  className={`tree-item file ${selectedIssue === issue.key ? "selected" : ""}`}
                  onClick={() => onIssueClick(issue.key)}
                  data-status-category={issue.statusCategory}
                  data-status={issue.status}
                  style={{ color: getStatusColor(issue.status, issue.statusCategory) }}
                >
                  <PriorityIcon priority={issue.priority} />
                  <span className="issue-key">{issue.key}</span>
                  <span className="node-name">{issue.summary}</span>
                </div>
              ))}
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
  const [repoPath, setRepoPath] = useState(() => getProjectRepoPath(projectKey));

  useEffect(() => {
    setLoading(true);
    setRepoPath(getProjectRepoPath(projectKey));
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
    saveProjectRepoPath(projectKey, repoPath);
    onSave();
  };

  const selectRepoFolder = async () => {
    const selected = await openDialog({
      directory: true,
      multiple: false,
      title: "Select Repository Folder",
    });
    if (selected) {
      setRepoPath(selected as string);
    }
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

        <div className="filter-section">
          <div className="filter-section-title">REPOSITORY</div>
          <div className="input-group">
            <label>Repository Path</label>
            <div className="repo-path-input">
              <input
                type="text"
                value={repoPath}
                placeholder="Click to select repository folder"
                readOnly
                onClick={selectRepoFolder}
              />
              {repoPath && (
                <button
                  type="button"
                  className="repo-path-clear"
                  onClick={(e) => { e.stopPropagation(); setRepoPath(""); }}
                >
                  <svg className="icon-sm" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5">
                    <path d="M2.5 2.5l7 7M9.5 2.5l-7 7" />
                  </svg>
                </button>
              )}
            </div>
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
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    Promise.all([
      fetchProjectIssueTypes(projectKey),
      fetchPriorities(),
      fetchAssignableUsers(projectKey),
      fetchCurrentUser(),
    ]).then(([types, prios, usrs, currentUser]) => {
      setIssueTypes(types);
      setPriorities(prios);
      setUsers(usrs);
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

function GlobalSettings({ onLogout }: { onLogout: () => void }) {
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
      if (e.key === "Escape") {
        setRecordingShortcut(null);
        return;
      }
      // Ignore modifier-only keys
      if (["Meta", "Control", "Alt", "Shift"].includes(e.key)) return;

      const newShortcut: Shortcut = {
        key: e.key.toLowerCase(),
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
  const [deletingWorktreeKey, setDeletingWorktreeKey] = useState<string | null>(null);

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

      // 2. Get all unique repo paths from project settings (for current connection)
      const prefix = getStoragePrefix();
      const repoPathPrefix = `${prefix}repo_path_`;
      const repoPaths = new Set<string>();
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && key.startsWith(repoPathPrefix)) {
          const path = localStorage.getItem(key);
          if (path) repoPaths.add(path);
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
    // Get repo path from project settings or from orphaned worktree
    const repoPath = wt.repoPath || (wt.projectKey ? getProjectRepoPath(wt.projectKey) : null);

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

    // 4. Delete local branch
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

    // 5. Delete remote branch
    if (repoPath && wt.info.branch && !wt.info.branch.startsWith("detached:")) {
      try {
        await invoke("run_git_command", {
          cwd: repoPath,
          args: ["push", "origin", "--delete", wt.info.branch],
        });
      } catch (e) {
        console.error(`Failed to delete remote branch ${wt.info.branch}:`, e);
      }
    }

    // 6. Remove from localStorage if not orphaned
    if (!wt.isOrphaned && wt.key) {
      localStorage.removeItem(wt.key);
    }
  };

  const deleteSingleWorktree = async (wt: WorktreeEntry) => {
    setDeletingWorktreeKey(wt.key);
    try {
      await deleteWorktreeEntry(wt);
      setWorktrees(prev => prev.filter(w => w.key !== wt.key));
    } finally {
      setDeletingWorktreeKey(null);
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

    // Process deletions without blocking UI
    const toDelete = [...worktrees];
    for (const wt of toDelete) {
      await deleteWorktreeEntry(wt);
      setWorktrees(prev => prev.filter(w => w.key !== wt.key));
    }
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
                  <div key={wt.key} className={`worktree-item ${deletingWorktreeKey === wt.key ? "deleting" : ""} ${wt.isOrphaned ? "orphaned" : ""}`}>
                    {deletingWorktreeKey === wt.key ? (
                      <div className="worktree-info">
                        <Spinner />
                        <span className="worktree-deleting-text">Deleting...</span>
                      </div>
                    ) : (
                      <>
                        <div className="worktree-info">
                          {wt.isOrphaned ? (
                            <span className="worktree-orphaned-label">Orphaned</span>
                          ) : (
                            <span className="worktree-issue">{wt.issueKey}</span>
                          )}
                          <span className="worktree-branch">{wt.info.branch}</span>
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
  isCollapsed: boolean;
  terminalHeight: number;
};

const issueTerminalStates = new Map<string, IssueTerminalState>();

function getIssueTerminalState(issueKey: string): IssueTerminalState {
  if (!issueTerminalStates.has(issueKey)) {
    issueTerminalStates.set(issueKey, {
      groups: [],
      activeGroupId: null,
      nextGroupId: 1,
      isCollapsed: false,
      terminalHeight: 400,
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
}>();

function TerminalInstance({ sessionId, fontSize, onSessionEnd }: {
  sessionId: number;
  fontSize: number;
  onSessionEnd?: () => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);

  // Update callback in cache
  useEffect(() => {
    const cached = terminalCache.get(sessionId);
    if (cached) {
      cached.onSessionEnd = onSessionEnd;
    }
  }, [sessionId, onSessionEnd]);

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

    // Korean IME workaround for Tauri WKWebView
    // Tauri's WKWebView doesn't fire compositionstart/end events properly,
    // so we handle Korean input via beforeinput events instead.
    const xtermTextarea = container.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement;
    let pendingKorean = '';
    let sentFromBeforeinput = new Set<string>();
    let expectingFirstKorean = false; // True after non-IME key, expecting first Korean input
    let beforeinputWorking = false; // Track if beforeinput is firing properly

    const isKoreanChar = (str: string) => {
      if (!str || str.length === 0) return false;
      const code = str.charCodeAt(0);
      return (code >= 0x1100 && code <= 0x11FF) ||   // Hangul Jamo
             (code >= 0x3130 && code <= 0x318F) ||   // Hangul Compatibility Jamo
             (code >= 0xAC00 && code <= 0xD7AF);     // Hangul Syllables
    };


    const flushPendingKorean = () => {
      if (pendingKorean) {
        invoke("write_to_pty", { sessionId, data: pendingKorean }).catch(console.error);
        sentFromBeforeinput.add(pendingKorean);
        pendingKorean = '';
        // Clear the set after a short delay to allow for onData check
        setTimeout(() => sentFromBeforeinput.clear(), 50);
      }
    };

    // Flush pending Korean on non-IME keydown
    term.attachCustomKeyEventHandler((e) => {
      if (e.type === 'keydown') {
        // Handle Option+Arrow keys - send macOS-style sequences
        if (e.altKey && !e.ctrlKey && !e.metaKey) {
          if (e.key === 'ArrowLeft') {
            invoke("write_to_pty", { sessionId, data: '\x1bb' }).catch(console.error); // ESC b = backward-word
            return false;
          } else if (e.key === 'ArrowRight') {
            invoke("write_to_pty", { sessionId, data: '\x1bf' }).catch(console.error); // ESC f = forward-word
            return false;
          } else if (e.key === 'Backspace') {
            invoke("write_to_pty", { sessionId, data: '\x1b\x7f' }).catch(console.error); // ESC DEL = backward-kill-word
            return false;
          }
        }

        // Skip modifier keys (Shift, Ctrl, Alt, Meta)
        const isModifier = (e.keyCode >= 16 && e.keyCode <= 18) || e.keyCode === 91 || e.keyCode === 93;

        if (e.keyCode === 229) {
          // IME key - if beforeinput fires, it's working
          // Will be confirmed in beforeinput handler
        } else if (!isModifier) {
          flushPendingKorean();
          // After a non-IME key (like space), expect first Korean input
          // where beforeinput might not fire properly
          expectingFirstKorean = true;
          beforeinputWorking = false;
        }
      }
      return true;
    });

    if (xtermTextarea) {
      xtermTextarea.addEventListener('beforeinput', (e: InputEvent) => {
        const inputType = e.inputType;
        const data = e.data || '';

        if (inputType === 'insertReplacementText') {
          // Composition update (e.g., ㅇ -> 아 -> 안)
          pendingKorean = data;
          beforeinputWorking = true;
          expectingFirstKorean = false;
        } else if (inputType === 'insertText' && isKoreanChar(data)) {
          beforeinputWorking = true;
          expectingFirstKorean = false;
          if (data === pendingKorean) {
            // Commit event - flush the completed character
            flushPendingKorean();
          } else {
            // New Korean character - flush previous and start new
            flushPendingKorean();
            pendingKorean = data;
          }
        }
      }, true);

      xtermTextarea.addEventListener('blur', () => {
        flushPendingKorean();
      }, true);
    }

    // Input handling
    let fallbackTimeout: number | null = null;

    term.onData((data) => {
      if (isKoreanChar(data)) {
        // Skip if we already sent this via beforeinput or have it pending
        if (sentFromBeforeinput.has(data) || pendingKorean === data || pendingKorean) {
          expectingFirstKorean = false;
          if (fallbackTimeout) {
            clearTimeout(fallbackTimeout);
            fallbackTimeout = null;
          }
          return;
        }
        // Fallback: only for first Korean input after IME switch
        // when beforeinput didn't fire - use delay to give beforeinput a chance
        if (expectingFirstKorean && !beforeinputWorking) {
          const koreanData = data;
          fallbackTimeout = window.setTimeout(() => {
            // Check again if beforeinput handled it
            if (!pendingKorean && !sentFromBeforeinput.has(koreanData) && !beforeinputWorking) {
              invoke("write_to_pty", { sessionId, data: koreanData }).catch(console.error);
              sentFromBeforeinput.add(koreanData);
              setTimeout(() => sentFromBeforeinput.delete(koreanData), 100);
            }
            fallbackTimeout = null;
          }, 10);
        }
        expectingFirstKorean = false;
        return;
      }

      // Clear any pending fallback
      if (fallbackTimeout) {
        clearTimeout(fallbackTimeout);
        fallbackTimeout = null;
      }

      // Flush pending Korean first, then send this data
      flushPendingKorean();
      invoke("write_to_pty", { sessionId, data }).catch(console.error);
    });

    // Event-based output handling
    const decoder = new TextDecoder('utf-8', { fatal: false });
    let unlistenOutput: (() => void) | null = null;
    let unlistenEnd: (() => void) | null = null;

    const setupListeners = async () => {
      unlistenOutput = await listen<number[]>(`pty-output-${sessionId}`, (event) => {
        const data = new Uint8Array(event.payload);
        term.write(decoder.decode(data, { stream: true }));
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
    terminalCache.set(sessionId, { term, fitAddon, onSessionEnd });

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
              <span>zsh</span>
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
            <TerminalInstance sessionId={id} fontSize={fontSize} onSessionEnd={() => onCloseTerminal(id)} />
          </div>
        ))}
      </div>
    </div>
  );
}

function TerminalPanel({ issueKey, projectKey }: { issueKey: string; projectKey: string }) {
  // Load state from global store
  const savedState = getIssueTerminalState(issueKey);
  const [repoPath, setRepoPath] = useState(() => getProjectRepoPath(projectKey) || null);
  const [worktreeInfo, setWorktreeInfo] = useState<WorktreeInfo | null>(() => getIssueWorktree(projectKey, issueKey));
  const [groups, setGroupsState] = useState<TerminalGroup[]>(savedState.groups);
  const [activeGroupId, setActiveGroupIdState] = useState<number | null>(savedState.activeGroupId);
  const [nextGroupId, setNextGroupIdState] = useState(savedState.nextGroupId);
  const [terminalHeight, setTerminalHeightState] = useState(savedState.terminalHeight);
  const [isCollapsed, setIsCollapsedState] = useState(savedState.isCollapsed);
  const [isResizing, setIsResizing] = useState(false);
  const [isMaximized, setIsMaximized] = useState(false);
  const [terminalFontSize] = useState(getTerminalFontSize);
  const [resizingGroupIndex, setResizingGroupIndex] = useState<number | null>(null);
  const groupsContainerRef = useRef<HTMLDivElement>(null);

  // Worktree setup state
  const [branches, setBranches] = useState<string[]>([]);
  const [currentBranch, setCurrentBranch] = useState<string>("");
  const [branchName, setBranchName] = useState("");
  const [baseBranch, setBaseBranch] = useState("");
  const [isLoadingBranches, setIsLoadingBranches] = useState(false);
  const [isCreatingWorktree, setIsCreatingWorktree] = useState(false);
  const [worktreeError, setWorktreeError] = useState<string | null>(null);
  const [branchMode, setBranchMode] = useState<"new" | "existing">("new");
  const [selectedExistingBranch, setSelectedExistingBranch] = useState("");

  // Worktree popover state
  const [showWorktreePopover, setShowWorktreePopover] = useState(false);
  const [isDeletingWorktree, setIsDeletingWorktree] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  // PR state
  const [prUrl, setPrUrl] = useState<string | null>(null);
  const [prState, setPrState] = useState<string | null>(null);
  const [prIsDraft, setPrIsDraft] = useState(false);
  const [prNumber, setPrNumber] = useState<number | null>(null);
  const currentPrCheckRef = useRef<{ branch: string; repoPath: string } | null>(null);

  // Flag to run ./setup.sh only on first terminal after worktree creation
  const justCreatedWorktreeRef = useRef(false);

  // Handle repository selection
  const selectRepository = async () => {
    const selected = await openDialog({
      directory: true,
      multiple: false,
      title: "Select Repository Folder",
    });
    if (selected) {
      const path = selected as string;
      saveProjectRepoPath(projectKey, path);
      setRepoPath(path);
    }
  };

  // Sync terminal state when issue changes
  const prevIssueKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (prevIssueKeyRef.current !== issueKey) {
      // Load state for the new issue
      const newState = getIssueTerminalState(issueKey);
      setGroupsState(newState.groups);
      setActiveGroupIdState(newState.activeGroupId);
      setNextGroupIdState(newState.nextGroupId);
      setIsCollapsedState(newState.isCollapsed);
      setTerminalHeightState(newState.terminalHeight);

      // Also update worktree info for the new issue
      setWorktreeInfo(getIssueWorktree(projectKey, issueKey));

      // Reset branch name and PR state
      setBranchName(issueKey.toLowerCase());
      setPrUrl(null);
      setPrState(null);
      setPrIsDraft(false);
      setPrNumber(null);
      currentPrCheckRef.current = null;

      prevIssueKeyRef.current = issueKey;
    }
  }, [issueKey, projectKey]);

  // Load branches when repoPath is set or issue changes
  useEffect(() => {
    if (!repoPath || worktreeInfo) return;
    setIsLoadingBranches(true);
    setBranches([]);
    setCurrentBranch("");
    setBaseBranch("");

    Promise.all([
      invoke("run_git_command", { cwd: repoPath, args: ["branch", "-a"] }),
      invoke("run_git_command", { cwd: repoPath, args: ["rev-parse", "--abbrev-ref", "HEAD"] }),
    ]).then(([branchOutput, currentOutput]) => {
      const branchList = (branchOutput as string)
        .split("\n")
        .map(b => b.trim().replace(/^\* /, ""))
        .filter(b => b && !b.startsWith("remotes/origin/HEAD"));
      setBranches(branchList);
      const current = (currentOutput as string).trim();
      setCurrentBranch(current);
      setBaseBranch(current);
    }).catch(e => {
      console.error("Failed to load branches:", e);
      setWorktreeError("Failed to load branches. Is this a git repository?");
    }).finally(() => {
      setIsLoadingBranches(false);
    });
  }, [repoPath, worktreeInfo, issueKey]);

  // Create worktree
  const createWorktree = async () => {
    const targetBranch = branchMode === "new" ? branchName : selectedExistingBranch;
    if (!repoPath || !targetBranch) return;
    if (branchMode === "new" && !baseBranch) return;

    setIsCreatingWorktree(true);
    setWorktreeError(null);

    // UI 업데이트 대기
    await new Promise(resolve => setTimeout(resolve, 50));

    // Sanitize branch name for folder (replace / with -)
    // For remote branches like "remotes/origin/branch", extract just the branch name
    let folderBranchName = targetBranch;
    if (folderBranchName.startsWith("remotes/")) {
      // Extract branch name after origin/ (e.g., "remotes/origin/feature/test" -> "feature/test")
      const parts = folderBranchName.split("/");
      folderBranchName = parts.slice(2).join("/");
    }
    const folderName = folderBranchName.replace(/\//g, "-");

    try {
      const homeDir: string = await invoke("get_home_dir");
      const repoFolderName = repoPath.split("/").pop() || "repo";
      const worktreeDir = `${homeDir}/.jeonghyeon/${repoFolderName}`;
      const worktreePath = `${worktreeDir}/${folderName}`;

      // Check if worktree path already exists
      const exists: boolean = await invoke("check_path_exists", { path: worktreePath });
      if (exists) {
        // Path exists, just use it
        const info = { path: worktreePath, branch: folderBranchName };
        saveIssueWorktree(projectKey, issueKey, info);
        setWorktreeInfo(info);
        return;
      }

      // Create directory structure
      await invoke("create_dir_all", { path: worktreeDir });

      if (branchMode === "new") {
        // Create worktree with new branch
        try {
          await invoke("run_git_command", {
            cwd: repoPath,
            args: ["worktree", "add", "-b", targetBranch, worktreePath, baseBranch],
          });
        } catch (e: any) {
          // Branch might already exist, try without -b flag
          console.warn("Failed with -b flag, trying existing branch:", e);
          await invoke("run_git_command", {
            cwd: repoPath,
            args: ["worktree", "add", worktreePath, targetBranch],
          });
        }

        const info = { path: worktreePath, branch: targetBranch };
        saveIssueWorktree(projectKey, issueKey, info);
        justCreatedWorktreeRef.current = true;
        setWorktreeInfo(info);
      } else {
        // Use existing branch
        // For remote branches, we need to handle them differently
        if (targetBranch.startsWith("remotes/")) {
          // Extract the branch name without remotes/origin/ prefix
          const parts = targetBranch.split("/");
          const remoteName = parts[1]; // e.g., "origin"
          const remoteBranchName = parts.slice(2).join("/");

          try {
            // Try creating worktree tracking the remote branch
            await invoke("run_git_command", {
              cwd: repoPath,
              args: ["worktree", "add", "--track", "-b", remoteBranchName, worktreePath, `${remoteName}/${remoteBranchName}`],
            });
          } catch (e: any) {
            // Local branch with same name might already exist, try without -b
            console.warn("Failed with --track -b, trying existing local branch:", e);
            await invoke("run_git_command", {
              cwd: repoPath,
              args: ["worktree", "add", worktreePath, remoteBranchName],
            });
          }

          const info = { path: worktreePath, branch: remoteBranchName };
          saveIssueWorktree(projectKey, issueKey, info);
          justCreatedWorktreeRef.current = true;
          setWorktreeInfo(info);
        } else {
          // Local branch
          await invoke("run_git_command", {
            cwd: repoPath,
            args: ["worktree", "add", worktreePath, targetBranch],
          });

          const info = { path: worktreePath, branch: targetBranch };
          saveIssueWorktree(projectKey, issueKey, info);
          justCreatedWorktreeRef.current = true;
          setWorktreeInfo(info);
        }
      }
    } catch (e: any) {
      console.error("Failed to create worktree:", e);
      setWorktreeError(e?.toString() || "Failed to create worktree");
    } finally {
      setIsCreatingWorktree(false);
    }
  };

  // Delete worktree
  const deleteWorktree = async () => {
    if (!worktreeInfo || !repoPath) return;
    setIsDeletingWorktree(true);

    // UI 업데이트 대기
    await new Promise(resolve => setTimeout(resolve, 50));

    try {
      // Close all terminal sessions first
      for (const group of groups) {
        for (const sessionId of group.terminals) {
          const cached = terminalCache.get(sessionId);
          if (cached) {
            cached.cleanup?.();
            cached.term.dispose();
            terminalCache.delete(sessionId);
          }
          try { await invoke("close_pty_session", { sessionId }); } catch {}
        }
      }

      // Remove worktree using git
      await invoke("run_git_command", {
        cwd: repoPath,
        args: ["worktree", "remove", worktreeInfo.path, "--force"],
      });
    } catch (e) {
      console.error("Failed to remove git worktree:", e);
      // Continue anyway - might already be removed or have issues
    }

    // Clear local state
    removeIssueWorktree(projectKey, issueKey);
    setWorktreeInfo(null);
    setGroupsState([]);
    setActiveGroupIdState(null);
    setNextGroupIdState(1);
    setIssueTerminalState(issueKey, {
      groups: [],
      activeGroupId: null,
      nextGroupId: 1,
      isCollapsed: false,
    });
    setShowWorktreePopover(false);
    setConfirmDelete(false);
    setIsDeletingWorktree(false);
    // Reset branch selection state
    setBranchMode("new");
    setSelectedExistingBranch("");
    setBranchName("");
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
  const setNextGroupId = (updater: number | ((n: number) => number)) => {
    setNextGroupIdState(prev => {
      const newVal = typeof updater === 'function' ? updater(prev) : updater;
      setIssueTerminalState(issueKey, { nextGroupId: newVal });
      return newVal;
    });
  };
  const setTerminalHeight = (h: number) => {
    setTerminalHeightState(h);
    setIssueTerminalState(issueKey, { terminalHeight: h });
  };
  const setIsCollapsed = (v: boolean) => {
    setIsCollapsedState(v);
    setIssueTerminalState(issueKey, { isCollapsed: v });
  };

  // Toggle terminal shortcut
  useEffect(() => {
    const shortcuts = getShortcuts();
    const handleKeyDown = (e: KeyboardEvent) => {
      if (matchesShortcut(e, shortcuts.toggleTerminal)) {
        e.preventDefault();
        setIsCollapsedState(prev => {
          const next = !prev;
          setIssueTerminalState(issueKey, { isCollapsed: next });
          return next;
        });
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [issueKey]);

  // Reload state when issueKey changes
  useEffect(() => {
    const state = getIssueTerminalState(issueKey);
    setGroupsState(state.groups);
    setActiveGroupIdState(state.activeGroupId);
    setNextGroupIdState(state.nextGroupId);
    setTerminalHeightState(state.terminalHeight);
    setIsCollapsedState(state.isCollapsed);
    setRepoPath(getProjectRepoPath(projectKey) || null);
    setWorktreeInfo(getIssueWorktree(projectKey, issueKey));
    setWorktreeError(null);
    setBranchMode("new");
    setSelectedExistingBranch("");
    setBranchName("");
    setPrUrl(null);
    setPrState(null);
    setPrNumber(null);
  }, [issueKey, projectKey]);

  // Check for open PR when worktree is set
  useEffect(() => {
    if (!worktreeInfo || !repoPath) {
      currentPrCheckRef.current = null;
      setPrUrl(null);
      setPrState(null);
      setPrIsDraft(false);
      setPrNumber(null);
      return;
    }

    const currentCheck = { branch: worktreeInfo.branch, repoPath };
    currentPrCheckRef.current = currentCheck;

    const checkPr = () => {
      // Double defer to completely isolate from React's event loop
      setTimeout(() => {
        if (currentPrCheckRef.current !== currentCheck) return;
        invoke("run_gh_command", {
          cwd: repoPath,
          args: ["pr", "list", "--head", worktreeInfo.branch, "--json", "url,state,isDraft,number", "--limit", "1"]
        }).then((result: unknown) => {
          if (currentPrCheckRef.current !== currentCheck) return;
          const data = JSON.parse(result as string);
          if (data.length > 0) {
            setPrUrl(data[0].url);
            setPrState(data[0].state);
            setPrIsDraft(data[0].isDraft || false);
            setPrNumber(data[0].number);
          } else {
            setPrUrl(null);
            setPrState(null);
            setPrIsDraft(false);
            setPrNumber(null);
          }
        }).catch(() => {
          if (currentPrCheckRef.current !== currentCheck) return;
          setPrUrl(null);
          setPrState(null);
          setPrIsDraft(false);
          setPrNumber(null);
        });
      }, 0);
    };

    // Delay initial PR check to not block issue switching
    const timeout = setTimeout(checkPr, 500);
    // Refresh PR status every 60 seconds
    const interval = setInterval(checkPr, 60000);
    return () => {
      clearTimeout(timeout);
      clearInterval(interval);
    };
  }, [worktreeInfo, repoPath]);

  // Auto-create terminal when worktree is ready and no terminals exist
  useEffect(() => {
    // Get the correct worktree for THIS issue (not from stale state)
    const currentWorktree = getIssueWorktree(projectKey, issueKey);
    const currentTerminalPath = currentWorktree?.path || null;
    if (!currentTerminalPath) return;
    const state = getIssueTerminalState(issueKey);
    if (state.groups.length === 0) {
      const groupId = state.nextGroupId;
      const shouldRunSetup = justCreatedWorktreeRef.current;
      justCreatedWorktreeRef.current = false; // Reset flag immediately
      invoke("create_pty_session", { rows: 24, cols: 80, cwd: currentTerminalPath }).then((sessionId: unknown) => {
        const newGroup = { id: groupId, terminals: [sessionId as number], activeTerminal: sessionId as number, flex: 1 };
        setGroupsState([newGroup]);
        setActiveGroupIdState(groupId);
        setNextGroupIdState(groupId + 1);
        setIsCollapsedState(false);
        setIssueTerminalState(issueKey, {
          groups: [newGroup],
          activeGroupId: groupId,
          nextGroupId: groupId + 1,
          isCollapsed: false
        });
        // Run ./setup.sh only on first terminal after worktree creation
        if (shouldRunSetup) {
          // Wait for first PTY output (shell ready) before sending command
          let unlistenFn: (() => void) | null = null;
          listen(`pty-output-${sessionId}`, () => {
            invoke("write_to_pty", { sessionId, data: "./setup.sh\n" }).catch(console.error);
            unlistenFn?.();
          }).then(fn => { unlistenFn = fn; });
        }
      }).catch(e => console.error("Failed to create PTY:", e));
    }
  }, [issueKey, projectKey, terminalPath]);

  const createNewGroup = async () => {
    const currentWorktree = getIssueWorktree(projectKey, issueKey);
    const cwd = currentWorktree?.path;
    if (!cwd) return;
    const groupId = nextGroupId;
    setNextGroupId(n => n + 1);
    try {
      const sessionId: number = await invoke("create_pty_session", { rows: 24, cols: 80, cwd });
      setGroups(prev => [...prev, { id: groupId, terminals: [sessionId], activeTerminal: sessionId, flex: 1 }]);
      setActiveGroupId(groupId);
      setIsCollapsed(false);
    } catch (e) {
      console.error("Failed to create PTY:", e);
    }
  };

  const addTerminalToGroup = async (groupId: number) => {
    const currentWorktree = getIssueWorktree(projectKey, issueKey);
    const cwd = currentWorktree?.path;
    if (!cwd) return;
    try {
      const sessionId: number = await invoke("create_pty_session", { rows: 24, cols: 80, cwd });
      setGroups(prev => prev.map(g =>
        g.id === groupId ? { ...g, terminals: [...g.terminals, sessionId], activeTerminal: sessionId } : g
      ));
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

  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    if (!isMaximized) setIsResizing(true);
  }, [isMaximized]);

  useEffect(() => {
    if (!isResizing) return;
    const onMove = (e: MouseEvent) => {
      const h = window.innerHeight - e.clientY - 22;
      if (h >= 150 && h <= window.innerHeight - 80) setTerminalHeight(h);
    };
    const onUp = () => setIsResizing(false);
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    return () => { document.removeEventListener("mousemove", onMove); document.removeEventListener("mouseup", onUp); };
  }, [isResizing]);

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
      }
    };
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [terminalPath, activeGroupId]);

  // Show connect repository UI if no repo path is set
  if (!repoPath) {
    return (
      <div className={`terminal-panel ${isMaximized && !isCollapsed ? "maximized" : ""}`} style={{ height: isCollapsed ? 32 : isMaximized ? "100%" : terminalHeight }}>
        {!isCollapsed && !isMaximized && <div className="terminal-resize-handle" onMouseDown={handleResizeStart} />}
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
          <div className="terminal-connect-repo">
            <div className="terminal-connect-icon">
              <svg className="icon-3xl" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
              </svg>
            </div>
            <div className="terminal-connect-text">
              <div className="terminal-connect-title">Connect Repository</div>
              <div className="terminal-connect-desc">Select the local repository folder for this project to enable the terminal.</div>
            </div>
            <button className="terminal-connect-btn" onClick={selectRepository}>
              Select Folder
            </button>
          </div>
        )}
      </div>
    );
  }

  // Show worktree setup UI if no worktree exists
  if (!worktreeInfo) {
    return (
      <div className={`terminal-panel ${isMaximized && !isCollapsed ? "maximized" : ""}`} style={{ height: isCollapsed ? 32 : isMaximized ? "100%" : terminalHeight }}>
        {!isCollapsed && !isMaximized && <div className="terminal-resize-handle" onMouseDown={handleResizeStart} />}
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
          <div className="terminal-worktree-setup">
            {isCreatingWorktree ? (
              <div className="terminal-worktree-loading">
                <div className="terminal-worktree-spinner" />
                <div className="terminal-worktree-loading-text">Setting up worktree...</div>
              </div>
            ) : isLoadingBranches ? (
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
                  {branchMode === "new" && (
                    <div className="terminal-worktree-field">
                      <label>Base Branch</label>
                      <select value={baseBranch} onChange={(e) => setBaseBranch(e.target.value)}>
                        {branches.filter(b => !b.startsWith("remotes/")).length > 0 && (
                          <optgroup label="Local">
                            {branches.filter(b => !b.startsWith("remotes/")).map(b => (
                              <option key={b} value={b}>{b}{b === currentBranch ? " (current)" : ""}</option>
                            ))}
                          </optgroup>
                        )}
                        {branches.filter(b => b.startsWith("remotes/")).length > 0 && (
                          <optgroup label="Remote">
                            {branches.filter(b => b.startsWith("remotes/")).map(b => (
                              <option key={b} value={b}>{b.replace("remotes/", "")}</option>
                            ))}
                          </optgroup>
                        )}
                      </select>
                    </div>
                  )}
                  <div className="terminal-worktree-field">
                    <label>Branch</label>
                    <div className="terminal-worktree-branch-input">
                      {branchMode === "new" ? (
                        <input
                          type="text"
                          value={branchName}
                          onChange={(e) => setBranchName(e.target.value)}
                          placeholder={issueKey.toLowerCase()}
                        />
                      ) : (
                        <select
                          value={selectedExistingBranch}
                          onChange={(e) => setSelectedExistingBranch(e.target.value)}
                        >
                          <option value="">Select branch...</option>
                          {branches.filter(b => !b.startsWith("remotes/")).length > 0 && (
                            <optgroup label="Local">
                              {branches.filter(b => !b.startsWith("remotes/")).map(b => (
                                <option key={b} value={b}>{b}{b === currentBranch ? " (current)" : ""}</option>
                              ))}
                            </optgroup>
                          )}
                          {branches.filter(b => b.startsWith("remotes/")).length > 0 && (
                            <optgroup label="Remote">
                              {branches.filter(b => b.startsWith("remotes/")).map(b => (
                                <option key={b} value={b}>{b.replace("remotes/", "")}</option>
                              ))}
                            </optgroup>
                          )}
                        </select>
                      )}
                      <button
                        className="terminal-worktree-mode-btn"
                        onClick={() => setBranchMode(branchMode === "new" ? "existing" : "new")}
                        title={branchMode === "new" ? "Use existing branch" : "Create new branch"}
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
                  <button
                    className="terminal-connect-btn"
                    onClick={createWorktree}
                    disabled={branchMode === "new" ? (!branchName || !baseBranch) : !selectedExistingBranch}
                  >
                    Create Worktree
                  </button>
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
      {!isCollapsed && !isMaximized && <div className="terminal-resize-handle" onMouseDown={handleResizeStart} />}
      <div className="terminal-header">
        <div className="terminal-header-left">
          <span className="terminal-header-title">TERMINAL</span>
          {worktreeInfo && (
            <div className="terminal-branch-wrapper">
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
                  <div className="terminal-popover-backdrop" onClick={() => { if (!isDeletingWorktree) { setShowWorktreePopover(false); setConfirmDelete(false); } }} />
                  <div className="terminal-worktree-popover">
                    {isDeletingWorktree ? (
                      <div className="terminal-popover-loading">
                        <div className="terminal-worktree-spinner" />
                        <span>Deleting worktree...</span>
                      </div>
                    ) : confirmDelete ? (
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
                            <span className="terminal-popover-value">{worktreeInfo.branch}</span>
                          </div>
                          <div className="terminal-popover-row">
                            <span className="terminal-popover-label">Path</span>
                            <span className="terminal-popover-value terminal-popover-path">{worktreeInfo.path}</span>
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
          {prUrl && (
            <button
              className={`terminal-pr-badge ${prIsDraft ? 'draft' : prState === 'OPEN' ? 'open' : prState === 'MERGED' ? 'merged' : 'closed'}`}
              onClick={() => openUrl(prUrl)}
              title={prIsDraft ? 'Draft PR' : `PR ${prState?.toLowerCase()}`}
            >
              <svg className="icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="18" cy="18" r="3" /><circle cx="6" cy="6" r="3" /><path d="M6 9v6c0 1.1.9 2 2 2h3" /><path d="M18 9v6" />
              </svg>
              {prIsDraft ? 'Draft' : 'PR'}{prNumber ? ` #${prNumber}` : ''}
            </button>
          )}
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

function IssueDetailView({ issueKey, onIssueClick, onCreateChild, onRefresh, refreshTrigger }: { issueKey: string; onIssueClick: (key: string) => void; onCreateChild: (projectKey: string, parentKey: string) => void; onRefresh: () => void; refreshTrigger: number }) {
  const [showTerminal, _setShowTerminal] = useState(true);
  const [issue, setIssue] = useState<IssueDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Edit options
  const [transitions, setTransitions] = useState<{ id: string; name: string }[]>([]);
  const [users, setUsers] = useState<{ accountId: string; displayName: string }[]>([]);
  const [priorities, setPriorities] = useState<{ id: string; name: string }[]>([]);
  const [editValue, setEditValue] = useState("");
  const [newComment, setNewComment] = useState("");
  const [addingComment, setAddingComment] = useState(false);
  const [editingComment, setEditingComment] = useState<string | null>(null);
  const [editCommentValue, setEditCommentValue] = useState("");
  const [_replyTo, setReplyTo] = useState<{ author: string } | null>(null);
  const [copiedKey, setCopiedKey] = useState(false);
  const [copiedUrl, setCopiedUrl] = useState(false);

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
    fetchIssueDetail(issueKey).then(setIssue).catch(console.error);
  };

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setEditing(null);
    setEditValue("");
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
      fetchIssueDetail(issueKey).then(setIssue).catch(console.error);
    }
  }, [refreshTrigger]);

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
    }
  };

  const saveEdit = async (field: string, value: any) => {
    if (!issue) return;
    setSaving(true);
    try {
      if (field === "status") {
        await transitionIssue(issueKey, value);
      } else if (field === "assignee") {
        await updateIssueField(issueKey, "assignee", value ? { accountId: value } : null);
      } else if (field === "reporter") {
        await updateIssueField(issueKey, "reporter", value ? { accountId: value } : null);
      } else if (field === "priority") {
        await updateIssueField(issueKey, "priority", { id: value });
      } else if (field === "summary") {
        await updateIssueField(issueKey, "summary", value);
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
        await updateIssueField(issueKey, "description", adf);
      }
      reload();
      onRefresh();
    } catch (e) {
      console.error(e);
    } finally {
      setSaving(false);
      setEditing(null);
    }
  };

  if (loading) {
    return (
      <div className="issue-detail-container">
        <div className="issue-detail scrollable">
          <div className="skeleton-header">
            <div className="skeleton skeleton-badge" />
            <div className="skeleton skeleton-badge" />
          </div>
          <div className="skeleton skeleton-title" />
          <div className="skeleton-meta">
            <div className="skeleton skeleton-meta-item" />
            <div className="skeleton skeleton-meta-item" />
            <div className="skeleton skeleton-meta-item" />
            <div className="skeleton skeleton-meta-item" />
          </div>
          <div className="skeleton skeleton-line" />
          <div className="skeleton skeleton-line short" />
          <div className="skeleton skeleton-line" />
          <div className="skeleton skeleton-line shorter" />
        </div>
        {showTerminal && <TerminalPanel issueKey={issueKey} projectKey={getProjectKeyFromIssueKey(issueKey)} />}
      </div>
    );
  }

  if (error || !issue) {
    return (
      <div className="issue-detail-container">
        <div className="issue-detail scrollable">
          <div className="issue-error">Failed to load issue</div>
        </div>
        {showTerminal && <TerminalPanel issueKey={issueKey} projectKey={getProjectKeyFromIssueKey(issueKey)} />}
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

  // Format minutes to time string like "1h 30m"
  const formatMinutesToTime = (mins: number): string => {
    if (mins <= 0) return "";
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

  return (
    <div className="issue-detail-container">
      <div className="issue-detail scrollable">
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
          <div className="issue-type-badge">{issue.issueType}</div>
          <button
            className="create-child-btn"
            onClick={() => onCreateChild(issue.projectKey, issue.key)}
          >
            + Child
          </button>
        </div>

      {issue.parentKey && (
        <div className="issue-parent">
          <span className="parent-label">Parent:</span>
          <span className="parent-link" onClick={() => onIssueClick(issue.parentKey!)}>
            {issue.parentKey}
          </span>
          {issue.parentSummary && <span className="parent-summary">{issue.parentSummary}</span>}
        </div>
      )}

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
          <span className="meta-label">Created</span>
          <span className="meta-value">{formatDate(issue.created)}</span>
        </div>

        <div className="issue-meta-item">
          <span className="meta-label">Updated</span>
          <span className="meta-value">{formatDate(issue.updated)}</span>
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
                <span className="time-text editable" onClick={() => { setEditing("estimate"); setEstimateValue(issue.timeTracking?.originalEstimate || ""); }}>
                  {issue.timeTracking?.originalEstimate || "—"}
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
                <span className={`time-text editable ${timeExceeded ? "time-exceeded" : ""}`} onClick={() => { setEditing("remaining"); setRemainingValue(issue.timeTracking?.remainingEstimate || ""); }}>
                  {issue.timeTracking?.remainingEstimate || "—"}
                </span>
              )}
            </span>
            <span className="time-item">
              <span className="time-label-mini">Logged</span>
              <span className={`time-text editable ${timeExceeded ? "time-exceeded" : ""}`} onClick={() => { if (!showLogWork) { setLogTimeSpent(""); setLogComment(""); } setShowLogWork(!showLogWork); }}>
                {issue.timeTracking?.timeSpent || "—"}
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
                        <span className="editable" onClick={() => { setEditingWorklog(log.id); setEditWorklogField("time"); setEditWorklogTime(log.timeSpent); setEditWorklogComment(log.comment || ""); }}>{log.timeSpent}</span>
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
                          <span className="editable" onClick={() => { setEditingWorklog(log.id); setEditWorklogField("comment"); setEditWorklogTime(log.timeSpent); setEditWorklogComment(log.comment || ""); }}>{log.comment || ""}</span>
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
      {showTerminal && <TerminalPanel issueKey={issueKey} projectKey={getProjectKeyFromIssueKey(issueKey)} />}
    </div>
  );
}

const POLL_INTERVAL = 30000; // 30 seconds

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

function MainApp({ onLogout }: { onLogout: () => void }) {
  const [sidebarWidth, setSidebarWidth] = useState(400);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [isResizing, setIsResizing] = useState(false);
  const [settingsProject, setSettingsProject] = useState<string | null>(null);
  const [selectedIssue, setSelectedIssue] = useState<string | null>(null);
  const [refreshTrigger, setRefreshTrigger] = useState(0);
  const [hiddenProjects, setHiddenProjectsState] = useState<string[]>(getHiddenProjects());
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

  const startResizing = useCallback(() => setIsResizing(true), []);
  const stopResizing = useCallback(() => setIsResizing(false), []);

  const resize = useCallback(
    (e: React.MouseEvent) => {
      if (isResizing) {
        const newWidth = e.clientX;
        if (newWidth >= 120 && newWidth <= 600) {
          setSidebarWidth(newWidth);
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
    setSelectedIssue(issueKey);
    setSettingsProject(null);
    setCreateProject(null);
    setShowGlobalSettings(false);
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
        className="app"
        onMouseMove={resize}
        onMouseUp={stopResizing}
        onMouseLeave={stopResizing}
        onDragStart={(e) => e.preventDefault()}
      >
        <div className="sidebar scrollable" style={{ width: sidebarCollapsed ? 0 : sidebarWidth, display: sidebarCollapsed ? 'none' : undefined }} onMouseDown={() => (document.activeElement as HTMLElement)?.blur?.()}>
          <div className="sidebar-header">
            <span>Projects</span>
            <div style={{ display: 'flex', gap: 2, alignItems: 'center' }}>
              {hiddenProjects.length > 0 && (
                <button
                  className="hidden-toggle"
                  onClick={() => setShowHiddenPanel(!showHiddenPanel)}
                  title="Show hidden projects"
                >
                  {hiddenProjects.length} hidden
                </button>
              )}
              <button className="sidebar-toggle" onClick={() => setSidebarCollapsed(true)} title="Hide sidebar (Cmd+B)">
                <svg className="icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <rect x="3" y="3" width="18" height="18" rx="2"/>
                  <line x1="9" y1="3" x2="9" y2="21"/>
                </svg>
              </button>
            </div>
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
          <GlobalSettings onLogout={onLogout} />
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
          <IssueDetailView issueKey={selectedIssue} onIssueClick={handleIssueClick} onCreateChild={handleCreateChild} onRefresh={() => setRefreshTrigger(n => n + 1)} refreshTrigger={issueRefreshTrigger} />
        ) : (
          <div className="empty-detail">
            <div className="empty-detail-content">
              <div className="empty-detail-name">{__APP_NAME__}</div>
              <div className="empty-detail-version">v{__APP_VERSION__}</div>
            </div>
          </div>
        )}
      </div>
    </div>
    <div className="status-bar">
      <div className="status-bar-left">
        <PomodoroTimer />
      </div>
      <div className="status-bar-right">
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
