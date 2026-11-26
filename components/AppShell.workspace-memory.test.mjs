import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";
import vm from "node:vm";
import { createJiti } from "jiti";

const source = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");
const jiti = createJiti(import.meta.url);
const draftStore = await jiti.import("../lib/draft-store.ts");
const projectScopeHelpers = source.slice(source.indexOf("function assignedProjectId"), source.indexOf("function createProjectDraftId"));

function callbackBody(name, nextName) {
  const start = source.indexOf(`const ${name} = useCallback`);
  const end = source.indexOf(`\n  const ${nextName}`, start);
  assert.notEqual(start, -1, `${name} callback not found`);
  assert.notEqual(end, -1, `${nextName} callback not found after ${name}`);
  return source.slice(start, end);
}

test("explicit context changes invalidate a pending workspace restore", () => {
  const callbacks = [
    ["handleCwdChange", "handleSelectSession"],
    ["handleSelectSession", "handleNewSession"],
    ["handleNewSession", "hydrateSelectedSession"],
    ["handleSessionCreated", "handleAgentEnd"],
    ["handleSessionForked", "handleInitialRestoreDone"],
    ["handleSessionDeleted", "handleOpenFile"],
  ];

  for (const [name, nextName] of callbacks) {
    assert.match(callbackBody(name, nextName), /invalidateWorkspaceRestore\(\);/);
  }
});

test("all active-session transitions share one persistence effect", () => {
  const effect = source.match(/useEffect\(\(\) => \{\s+if \(!selectedSession\) return;[\s\S]*?setLastOpenSession\(projectKey, selectedSession\.id\);\s+\}, \[activeProjectId, selectedSession\]\);/)?.[0];
  assert.ok(effect);
  assert.equal([...source.matchAll(/\bsetLastOpenSession\(/g)].length, 1);
  const recorded = [];
  for (const [selectedSession, activeProjectId] of [[null, undefined], [{ id: "chat", projectKey: "directory" }, undefined], [{ id: "chat" }, "project"], [{ id: "chat" }, null]]) {
    vm.runInNewContext(stripTypeScriptTypes(projectScopeHelpers + effect), {
      selectedSession,
      activeProjectId,
      activeProjectKeyRef: { current: "old-directory" },
      useEffect: (callback) => callback(),
      setLastOpenSession: (...args) => recorded.push(args),
    });
  }
  assert.deepEqual(recorded, [["directory", "chat"], ["named-project:project", "chat"], ["standalone-chats", "chat"]]);
});

test("keeps chat scroll positions in page memory by session id", () => {
  assert.match(source, /useRef\(new Map<string, ChatScrollPosition>\(\)\)/);
  assert.match(source, /sessionScrollPositionsRef\.current\.set\(sessionId, position\)/);
  assert.match(source, /initialScrollPosition=\{selectedSession \? sessionScrollPositionsRef\.current\.get\(selectedSession\.id\) \?\? null : null\}/);
  assert.match(source, /onScrollPositionChange=\{handleSessionScrollPositionChange\}/);
  assert.doesNotMatch(source, /localStorage[^\n]*sessionScroll/i);
});

test("workspace restoration remains inside the cross-project branch", () => {
  assert.match(
    callbackBody("handleCwdChange", "handleSelectSession"),
    /if \(currentProject !== newProject\) \{[\s\S]*?restoreWorkspaceContext\(newProject, cwd\);[\s\S]*?\}/,
  );
});

test("New restores the draft after session navigation and workspace auto-restore", async (t) => {
  const callbacks = [
    callbackBody("restoreWorkspaceContext", "handleCwdChange"),
    callbackBody("handleCwdChange", "handleSelectSession"),
    callbackBody("handleSelectSession", "handleNewSession"),
    callbackBody("handleNewSession", "hydrateSelectedSession"),
  ].join("\n");
  const parkedKeyHelper = source.slice(source.indexOf("function parkedNewSessionDraftKey"), source.indexOf("export function AppShell"));
  const hookSource = await readFile(new URL("../hooks/useAgentSession.ts", import.meta.url), "utf8");
  const cleanupStart = hookSource.indexOf("    return () => {", hookSource.indexOf("  // Load session on mount"));
  const cleanupEnd = hookSource.indexOf("    // eslint-disable-next-line", cleanupStart);

  for (const { name, rememberedCwd, projectId } of [
    { name: "remembered session cwd: /draft-project", rememberedCwd: "/draft-project" },
    { name: "remembered session cwd: /draft-project-worktree", rememberedCwd: "/draft-project-worktree" },
    { name: "named project draft", rememberedCwd: "/draft-project", projectId: "named-project" },
    { name: "standalone draft", rememberedCwd: "/standalone-internal", projectId: null },
  ]) {
    await t.test(name, async () => {
      const cwd = projectId === null ? null : "/draft-project";
      const session = { id: "remembered", cwd: rememberedCwd, projectKey: cwd, projectId };
      const projectSnapshot = { assignments: {}, projects: [] };
      const response = Promise.withResolvers();
      const context = vm.createContext({
        ...draftStore,
        crypto: globalThis.crypto,
        queueMicrotask,
        URLSearchParams,
        window: { location: { pathname: "/", search: "" } },
        router: { replace() {} },
        fetch: () => response.promise,
        getLastOpenSession: (key) => key === cwd ? session.id : null,
        clearLastOpen() {},
        workspaceKeyOf: (value) => value.projectKey ?? value.cwd,
        useCallback: (callback) => callback,
        useGlobalKeyboardShortcuts() {},
        activeNewSessionDraftKeyRef: { current: `new:initial:${cwd ?? "standalone"}` },
        activeProjectKeyRef: { current: cwd },
        workspaceRestoreTokenRef: { current: 0 },
        suppressCwdBumpRef: { current: false },
        branchLeafChangeFnRef: { current: null },
        liveFollowFrameRef: { current: null },
        bashRecoveryIdRef: { current: 0 },
        cancelEventStreamGrace() {},
        closeEvents() {},
        isMobile: false,
        activeCwd: cwd,
        activeFileTabId: null,
        projectSnapshot,
        sessionCatalog: [],
        newSessionCwd: cwd,
        newSessionProjectId: projectId,
        newSessionDraftId: "initial",
        selectedSession: null,
        sessionKey: 0,
      });
      Object.defineProperty(context, "activeProjectId", { get: () => context.selectedSession ? context.selectedSession.projectId : context.newSessionProjectId });
      context.invalidateWorkspaceRestore = () => context.workspaceRestoreTokenRef.current++;
      for (const [setter] of callbacks.matchAll(/\bset[A-Z]\w*(?=\()/g)) {
        const state = setter[3].toLowerCase() + setter.slice(4);
        context[setter] = (value) => {
          context[state] = typeof value === "function" ? value(context[state]) : value;
        };
      }
      vm.runInContext(stripTypeScriptTypes(`${projectScopeHelpers}\n${parkedKeyHelper}\n${callbacks}
        globalThis.navigate = { handleCwdChange, handleSelectSession, handleNewSession };
      `), context);
      // Run the actual hook cleanup with the outgoing mount's captured draft key.
      const makeCleanup = vm.runInContext(stripTypeScriptTypes(`((isNew, newSessionDraftKey) => {
        const sessionHookMountedRef = { current: true };
        const newSessionPromotedRef = { current: false };
        ${hookSource.slice(cleanupStart, cleanupEnd)}
      })`), context);
      let mountedKey = context.sessionKey;
      let cleanup = makeCleanup(true, context.activeNewSessionDraftKeyRef.current);
      async function commit() {
        if (mountedKey !== context.sessionKey) {
          cleanup();
          mountedKey = context.sessionKey;
          const activeCwd = context.newSessionCwd ?? context.activeCwd;
          const key = context.selectedSession ? null : `new:${context.newSessionDraftId}:${activeCwd ?? "standalone"}`;
          context.activeNewSessionDraftKeyRef.current = key;
          cleanup = makeCleanup(!context.selectedSession, key);
        }
        await new Promise((resolve) => setImmediate(resolve));
      }

      const draft = { value: "unsent project draft", images: [{ data: "aGVsbG8=", mimeType: "image/png" }] };
      draftStore.setDraft(context.activeNewSessionDraftKeyRef.current, draft);
      context.navigate.handleSelectSession({ ...session, cwd });
      await commit();
      context.navigate.handleNewSession("direct-return", cwd, projectId);
      await commit();
      assert.deepEqual(draftStore.getDraft(context.activeNewSessionDraftKeyRef.current), draft);
      if (projectId !== undefined) {
        const otherProject = projectId === null ? "different-project" : null;
        context.navigate.handleNewSession("other", otherProject === null ? null : "/different-project", otherProject);
        await commit();
        assert.equal(draftStore.getDraft(context.activeNewSessionDraftKeyRef.current), null);
        context.navigate.handleNewSession("restored", cwd, projectId);
        await commit();
        assert.deepEqual(draftStore.getDraft(context.activeNewSessionDraftKeyRef.current), draft);
        draftStore.clearDraft(context.activeNewSessionDraftKeyRef.current);
        return;
      }
      context.navigate.handleSelectSession({ ...session, cwd });
      await commit();
      context.navigate.handleCwdChange("/other-project", "/other-project", "/other-project");
      await commit();
      context.navigate.handleCwdChange(cwd, cwd, cwd);
      await commit();
      assert.deepEqual(draftStore.getDraft(context.activeNewSessionDraftKeyRef.current), draft);
      response.resolve({ ok: true, json: async () => ({ sessions: [session] }) });
      await new Promise((resolve) => setImmediate(resolve));
      await commit();
      assert.equal(context.selectedSession.id, session.id);
      context.navigate.handleNewSession("after-auto-restore", cwd);
      await commit();
      assert.deepEqual(draftStore.getDraft(context.activeNewSessionDraftKeyRef.current), draft);
      draftStore.clearDraft(context.activeNewSessionDraftKeyRef.current);
    });
  }
});
