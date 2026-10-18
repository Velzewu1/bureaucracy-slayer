// Minimal ambient typing for the small chrome.* surface this extension uses.
// Kept local so no new dependency (@types/chrome) is needed.

declare namespace chrome {
  namespace runtime {
    const id: string;
    function getURL(path: string): string;
    interface MessageSender {
      id?: string;
      url?: string;
      tab?: unknown;
    }
    const onMessage: {
      addListener(
        listener: (
          message: unknown,
          sender: MessageSender,
          sendResponse: (response: unknown) => void,
        ) => boolean | void,
      ): void;
    };
    function sendMessage(message: unknown): Promise<unknown>;
  }
  namespace storage {
    interface Area {
      get(keys: string | string[]): Promise<Record<string, unknown>>;
      set(items: Record<string, unknown>): Promise<void>;
      remove(keys: string | string[]): Promise<void>;
    }
    const session: Area;
    const onChanged: {
      addListener(listener: (changes: Record<string, unknown>, areaName: string) => void): void;
    };
  }
  namespace tabs {
    interface Tab {
      id?: number;
      url?: string;
      active?: boolean;
      windowId?: number;
      lastAccessed?: number;
    }
    interface QueryInfo {
      active?: boolean;
      currentWindow?: boolean;
      lastFocusedWindow?: boolean;
      url?: string | string[];
    }
    function query(info: QueryInfo): Promise<Tab[]>;
    function get(tabId: number): Promise<Tab>;
    function update(tabId: number, props: { url?: string; active?: boolean }): Promise<Tab | undefined>;
    function create(props: { url: string; active?: boolean }): Promise<Tab>;
    function sendMessage(tabId: number, message: unknown): Promise<unknown>;
    const onUpdated: {
      addListener(
        listener: (tabId: number, changeInfo: { status?: string; url?: string }, tab: Tab) => void,
      ): void;
      removeListener(
        listener: (tabId: number, changeInfo: { status?: string; url?: string }, tab: Tab) => void,
      ): void;
    };
    const onActivated: { addListener(listener: () => void): void };
  }
  namespace sidePanel {
    function setPanelBehavior(behavior: { openPanelOnActionClick: boolean }): Promise<void>;
  }
}
