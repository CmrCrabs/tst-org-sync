const TST_ID = "treestyletab@piro.sakura.ne.jp";
const EXT_ID = browser.runtime.getManifest().browser_specific_settings.gecko.id;

browser.runtime.onInstalled.addListener(onInstalled);
browser.runtime.onStartup.addListener(onStartup);

let scheduleLocalUpdate;
initialise();

browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    (async () => {
        await initialise();
        await onMessage(message, sender, sendResponse);
    })();
    return true;
});
browser.runtime.onMessageExternal.addListener(onMessageExternal);

browser.tabs.onRemoved.addListener(() => {
    updateWrittenState("pending");
    scheduleLocalUpdate();
});
browser.tabs.onMoved.addListener(() => {
    updateWrittenState("pending");
    scheduleLocalUpdate();
});
browser.tabs.onUpdated.addListener(
    () => {
        updateWrittenState("pending");
        scheduleLocalUpdate();
    },
    { properties: ["status", "pinned"] },
);

async function initialise() {
    const { timeout = 5000 } = await browser.storage.local.get("timeout");

    scheduleLocalUpdate = debounce(updateLocalState, timeout);

    await registerToTST();
}

function onInstalled() {
    browser.storage.local.set({ timeout: 5000 });
    updateWrittenState("suspended");
    updateBackupState(false);
}

function onStartup() {
    updateWrittenState("suspended");
    updateBackupState(false);
}

function onErr(e) {
    console.error(e);
}

function debounce(callback, wait) {
    let timeoutId = null;

    const debounced = (...args) => {
        clearTimeout(timeoutId);

        timeoutId = setTimeout(() => {
            timeoutId = null;
            callback(...args);
        }, wait);
    };

    debounced.setTimeout = (timeout) => {
        wait = timeout;
        clearTimeout(timeoutId);
        timeoutId = null;
    };

    return debounced;
}
async function readTSTTabs() {
    let tst_tree = await browser.runtime
        .sendMessage(TST_ID, {
            type: "get-tree",
            window: 0,
            tabs: "*",
        })
        .catch(onErr);

    return await Promise.all(
        tst_tree.flat().map(async (tstt) => {
            const tab = await browser.tabs.get(tstt.id);

            return {
                id: tab.id,
                indent: tstt.indent,
                index: tab.index,
                pinned: tab.pinned,
                group: tab.url.includes("group-tab.html?"),
                url: tab.url,
                title: tab.title,
            };
        }),
    );
}

function generateOrg(tabs) {
    return tabs
        .map((t) => {
            let url = t.group ? t.title : `[[${t.url}][${t.title}]]`;
            return `${"*".repeat(t.indent + 1)} ${t.pinned ? "PINNED " : ""}${url}`;
        })
        .join("\n");
}

async function writeEmacs(body) {
    let response = await fetch("http://localhost:8080/tst-org-sync/write", {
        method: "POST",
        headers: {
            "Content-Type": "text/plain",
        },
        body: body,
    }).then((r) => r.text(), onErr);
    return response;
}

async function readTimestamp() {
    let response = await fetch("http://localhost:8080/tst-org-sync/read-timestamp").catch(onErr);
    let responseStr = await response.text();
    return parseInt(responseStr.replaceAll(" ", ""));
}

async function updateLocalState(override = false) {
    let autoBackup = (await browser.storage.local.get("autoBackup")).autoBackup;
    if (autoBackup || override) {
        console.log("Attempting Local File Write...");
        let writable = await Writable();

        if (writable || override) {
            let tabs = await readTSTTabs();
            let org = generateOrg(tabs);
            let response = await writeEmacs(org);
            console.log(response);

            await updateModificationTime();
        } else {
            console.log("...Write stopped, writing suspended.");
        }
        updateWrittenState((await Writable()) ? "written" : "suspended");
    }
}

async function readLocalFile() {
    let response = await fetch("http://localhost:8080/tst-org-sync/read-file").catch(onErr);
    return await response.text();
}

function parseOrg(org) {
    return org
        .split("\n")
        .filter((l) => l[0] === "*")
        .map((line, index) => {
            if (line.includes("[")) {
                let l = line.split("[");
                return {
                    indent: l[0].split(" ").at(0).trim().length - 1,
                    id: null,
                    pinned: l[0].includes("PINNED"),
                    index: index,
                    url: l[2].slice(0, -1),
                    title: l[3].slice(0, -2),
                };
            } else {
                let l = line.split(" ");
                let title = l.slice(1).join(" ");
                return {
                    indent: l[0].length - 1,
                    id: null,
                    pinned: false,
                    index: index,
                    url: `ext+treestyletab:group?title=${title}`,
                    title: title,
                };
            }
        });
}

async function updateTSTState() {
    let org = await readLocalFile();
    let localTabs = parseOrg(org);

    let currentTabs = await browser.tabs.query({ currentWindow: true });
    let tempTab = await browser.tabs.create({});
    currentTabs.forEach((tab) => {
        browser.tabs.remove(tab.id);
    });

    for (const tab of localTabs) {
        if (tab.url.includes("about:")) {
            continue;
        }
        let createdTab = await browser.tabs.create({
            index: tab.index,
            url: tab.url,
            pinned: tab.pinned,
        });

        for (let i = 0; i < tab.indent; i++) {
            let success = await browser.runtime.sendMessage(TST_ID, {
                type: "indent",
                tab: createdTab.id,
            });
        }
    }
    browser.tabs.remove(tempTab.id);

    console.log("Synced TST state with local file.");

    await updateModificationTime();
    updateWrittenState((await Writable()) ? "written" : "suspended");
}

async function updateModificationTime() {
    let timestamp = await readTimestamp();
    await browser.storage.local.set({ modificationTime: timestamp });
}

async function updateBackupState(state) {
    let autoBackup = (await browser.storage.local.get("autoBackup")).autoBackup;
    if (autoBackup != state) {
        await browser.storage.local.set({ autoBackup: state });

        console.log(`Auto Backups have been ${state ? "enabled" : "disabled"}.`);
        browser.runtime.sendMessage(EXT_ID, `${state ? "backupOn" : "backupOff"}`).catch((e) => {});
    }
}

async function updateWrittenState(state) {
    let writtenState = (await browser.storage.local.get("writtenState")).writtenState;
    if (writtenState != state) {
        await browser.storage.local.set({ writtenState: state });

        browser.runtime.sendMessage(EXT_ID, state).catch((e) => {});
    }
}

async function Writable() {
    let timestamp = await readTimestamp();
    let savedTimestamp = await browser.storage.local.get("modificationTime");
    return timestamp === savedTimestamp.modificationTime;
}

async function onMessageExternal(message, sender) {
    switch (sender.id) {
        case TST_ID:
            if (message && message.messages) {
                for (const oneMessage of message.messages) {
                    onMessageExternal(oneMessage, sender);
                }
            }
            switch (message && message.type) {
                case "permissions-changed":
                case "ready":
                    registerToTST();
                    break;
                case "tree-attached":
                case "tree-detached":
                    await updateWrittenState("pending");
                    scheduleLocalUpdate();
                    break;
            }
            break;
    }
}

async function onMessage(message, sender, sendResponse) {
    switch (sender.id) {
        case EXT_ID:
            let writtenState = (await browser.storage.local.get("writtenState")).writtenState;
            let autoBackup = (await browser.storage.local.get("autoBackup")).autoBackup;
            let timeout = (await browser.storage.local.get("timeout")).timeout;
            switch (message.type) {
                case "statusUpdate":
                    sendResponse({
                        writtenState: writtenState,
                        autoBackup: autoBackup,
                        timeout: timeout,
                    });
                    break;
                case "updateTST":
                    updateTSTState();
                    sendResponse("success");
                    break;
                case "updateLocal":
                    updateLocalState(true);
                    sendResponse("success");
                    break;

                case "updateTimeout":
                    timeout = message.value;
                    await browser.storage.local.set({ timeout: message.value });
                    scheduleLocalUpdate.setTimeout(timeout);
                    sendResponse("success");
                    break;
                case "BackupOn":
                    await updateBackupState(true);
                    if (writtenState === "pending") {
                        updateLocalState();
                    }
                    sendResponse("success");
                    break;
                case "BackupOff":
                    updateBackupState(false);
                    sendResponse("success");
                    break;
            }
            break;
    }
}

async function registerToTST() {
    const result = await browser.runtime
        .sendMessage(TST_ID, {
            type: "register-self",
            name: browser.i18n.getMessage("tst-org-backup"),
            icons: browser.runtime.getManifest().icons,
            listeningTypes: [
                "wait-for-shutdown",
                "ready",
                "permissions-changed",
                "tree-attached",
                "tree-detached",
            ],
            allowBulkMessaging: true,
            style: ` `,
            permissions: ["tabs"],
        })
        .catch(onErr);
    console.log("Registered to TST");

    browser.runtime
        .sendMessage(TST_ID, {
            type: "wait-for-shutdown",
        })
        .finally(() => {
            console.log("TST has been shutdown.");
        });
}
