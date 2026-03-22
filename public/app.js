(function () {
  const CONFIG = window.POWERUP_CONFIG || {};
  const T = window.TrelloPowerUp;
  let iframeContext = null;
  let resizeQueued = false;
  let resizeObserver = null;
  const boardLabelCache = new Map();

  const STORAGE_KEY = "cardNesting";
  const REFRESH_SIGNAL_KEY = "cardNestingRefreshSignal";

  function ensureConfig() {
    if (!CONFIG.apiKey || CONFIG.apiKey === "REPLACE_WITH_TRELLO_API_KEY") {
      console.warn("Trello API key is not configured in public/config.js");
    }
  }

  function getIframeContext() {
    if (!T || typeof T.iframe !== "function") {
      throw new Error("Trello iframe context is not available.");
    }

    if (!iframeContext) {
      iframeContext = T.iframe();
    }

    return iframeContext;
  }

  function requestFrameResize() {
    const page = document.body && document.body.dataset ? document.body.dataset.page : "";
    if (!T || typeof T.iframe !== "function" || page === "connector") {
      return;
    }

    if (resizeQueued) {
      return;
    }

    resizeQueued = true;

    window.requestAnimationFrame(function () {
      resizeQueued = false;

      try {
        const resizeTarget =
          document.getElementById("content") ||
          document.querySelector(".page") ||
          document.body;

        getIframeContext().sizeTo(resizeTarget);
      } catch (error) {
        // Ignore resize errors when not inside a resizable Trello iframe.
      }
    });
  }

  function watchFrameSize() {
    if (resizeObserver || typeof window.ResizeObserver !== "function") {
      return;
    }

    const resizeTarget =
      document.getElementById("content") ||
      document.querySelector(".page") ||
      document.body;

    if (!resizeTarget) {
      return;
    }

    resizeObserver = new window.ResizeObserver(function () {
      requestFrameResize();
    });

    resizeObserver.observe(resizeTarget);
  }

  function getStoredToken() {
    return window.localStorage.getItem("trello_token") || "";
  }

  function setStoredToken(token) {
    window.localStorage.setItem("trello_token", token);
  }

  function clearStoredToken() {
    window.localStorage.removeItem("trello_token");
  }

  function broadcastRefreshSignal(reason) {
    try {
      window.localStorage.setItem(
        REFRESH_SIGNAL_KEY,
        JSON.stringify({
          reason: reason || "update",
          at: Date.now()
        })
      );
    } catch (error) {
      // Ignore localStorage issues and rely on focus-based refresh as fallback.
    }
  }

  function isAuthorized() {
    return Boolean(getStoredToken());
  }

  async function authorizeWithTrello() {
    ensureConfig();

    const currentT = getIframeContext();

    const returnUrl = `${CONFIG.appUrl.replace(/\/$/, "")}/auth.html`;
    const authUrl = [
      "https://trello.com/1/authorize",
      "?expiration=never",
      `&name=${encodeURIComponent(CONFIG.appName || "Card Nesting")}`,
      `&scope=${encodeURIComponent("read,write")}`,
      "&response_type=token",
      "&callback_method=fragment",
      `&return_url=${encodeURIComponent(returnUrl)}`,
      `&key=${encodeURIComponent(CONFIG.apiKey || "")}`
    ].join("");

    const token = await currentT.authorize(authUrl, {
      width: 720,
      height: 680,
      validToken: function (returnedToken) {
        return typeof returnedToken === "string" && returnedToken.length > 10;
      }
    });

    setStoredToken(token);
    return token;
  }

  async function ensureAuthorized() {
    const token = getStoredToken();
    if (token) {
      return token;
    }

    return authorizeWithTrello();
  }

  async function api(path, options = {}) {
    const token = await ensureAuthorized();
    const url = new URL(`https://api.trello.com/1${path}`);
    url.searchParams.set("key", CONFIG.apiKey || "");
    url.searchParams.set("token", token);

    if (options.query) {
      for (const [key, value] of Object.entries(options.query)) {
        if (value === undefined || value === null || value === "") continue;
        url.searchParams.set(key, String(value));
      }
    }

    const response = await fetch(url.toString(), {
      method: options.method || "GET",
      headers: {
        "Content-Type": "application/json",
        ...(options.headers || {})
      },
      body: options.body ? JSON.stringify(options.body) : undefined
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Trello API error ${response.status}: ${text}`);
    }

    const contentType = response.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      return response.json();
    }

    return response.text();
  }

  async function getStore(targetT = getIframeContext()) {
    const store = await targetT.get("board", "shared", STORAGE_KEY);
    return {
      parentsById: {},
      ...(store || {}),
      parentsById: {
        ...((store && store.parentsById) || {})
      }
    };
  }

  async function setStore(nextStore, targetT = getIframeContext()) {
    await targetT.set("board", "shared", STORAGE_KEY, nextStore);
    return nextStore;
  }

  async function updateStore(mutator, targetT = getIframeContext()) {
    const current = await getStore(targetT);
    const draft = JSON.parse(JSON.stringify(current));
    const result = await mutator(draft);
    await setStore(result || draft, targetT);
    return result || draft;
  }

  async function getCurrentContext(targetT = getIframeContext()) {
    const [card, board, list, store] = await Promise.all([
      targetT.card("id", "name", "desc", "idList", "shortLink", "url", "labels"),
      targetT.board("id", "name"),
      targetT.list("id", "name"),
      getStore(targetT)
    ]);

    return { card, board, list, store };
  }

  function makeId() {
    if (window.crypto && typeof window.crypto.randomUUID === "function") {
      return window.crypto.randomUUID();
    }

    return `child_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  }

  function normalizeLabels(labels) {
    return (labels || [])
      .filter(function (label) {
        return Boolean(label) && typeof label === "object" && !Array.isArray(label);
      })
      .map(function (label) {
        return {
          id: label.id || "",
          color: label.color || "",
          name: label.name || ""
        };
      })
      .filter(function (label) {
        return Boolean(label.color || label.name);
      });
  }

  function getCardLabels(card) {
    return normalizeLabels((card && card.labels) || (card && card.idLabels) || []);
  }

function normalizeParentEntry(parentCardId, entry) {
  return {
    parentCardId,
    label: (entry && entry.label) || "",
    childItems: Array.isArray(entry && entry.childItems)
      ? entry.childItems.map(normalizeStoredChildItem)
      : []
  };
}

function normalizeStoredChildItem(childItem) {
  return {
    id: (childItem && childItem.id) || makeId(),
    title: (childItem && childItem.title) || "",
    description: (childItem && childItem.description) || "",
    createdAt: (childItem && childItem.createdAt) || "",
    sourceCardId: (childItem && childItem.sourceCardId) || ""
  };
}

function buildStoredChildItem(childInput) {
  return normalizeStoredChildItem({
    id: makeId(),
    title: (childInput.title || "").trim(),
    description: (childInput.description || "").trim(),
    createdAt: new Date().toISOString(),
    sourceCardId: childInput.sourceCardId || ""
  });
}

  function getParentEntry(store, parentCardId) {
    return normalizeParentEntry(parentCardId, store.parentsById[parentCardId]);
  }

  function ensureParentEntry(store, parentCardId, seed = {}) {
    const entry = normalizeParentEntry(parentCardId, store.parentsById[parentCardId] || seed);
    store.parentsById[parentCardId] = entry;
    return entry;
  }

  function isParentCard(store, cardId) {
    return Boolean(store.parentsById[cardId]);
  }

function findEmbeddedSource(store, cardId) {
  for (const [parentCardId, rawEntry] of Object.entries(store.parentsById || {})) {
    const entry = normalizeParentEntry(parentCardId, rawEntry);
    const childItem = entry.childItems.find((item) => item.sourceCardId === cardId);
    if (childItem) {
      return {
        parentCardId,
        childItem
      };
    }
  }

  return null;
}

  async function getBoardCard(id) {
    return api(`/cards/${id}`, {
      query: {
        fields: "id,name,desc,idList,shortLink,url,closed,idLabels",
        labels: "all",
        label_fields: "color,name",
        labels_limit: "20"
      }
    });
  }

  async function getBoardCards(boardId) {
    return api(`/boards/${boardId}/cards`, {
      query: {
        fields: "id,name,desc,idList,shortLink,url,closed,idLabels",
        filter: "open",
        labels: "all",
        label_fields: "color,name",
        labels_limit: "20"
      }
    });
  }

  async function getBoardLists(boardId) {
    return api(`/boards/${boardId}/lists`, {
      query: {
        fields: "id,name",
        filter: "open"
      }
    });
  }

  async function getBoardLabels(boardId) {
    if (!boardId) {
      return [];
    }

    if (boardLabelCache.has(boardId)) {
      return boardLabelCache.get(boardId);
    }

    const labels = await api(`/boards/${boardId}/labels`, {
      query: {
        fields: "color,name",
        limit: "1000"
      }
    });

    const normalizedLabels = normalizeLabels(labels);
    boardLabelCache.set(boardId, normalizedLabels);
    return normalizedLabels;
  }

  function getCardLabelIds(card) {
    return Array.isArray(card && card.idLabels)
      ? card.idLabels
          .map(function (label) {
            if (typeof label === "string") {
              return label;
            }

            return label && typeof label === "object" ? label.id || "" : "";
          })
          .filter(Boolean)
      : [];
  }

  async function resolveCardLabels(card, boardId) {
    const directLabels = getCardLabels(card);
    if (directLabels.length) {
      return directLabels;
    }

    const labelIds = getCardLabelIds(card);
    if (!labelIds.length || !boardId) {
      return [];
    }

    const boardLabels = await getBoardLabels(boardId);
    const labelsById = new Map(
      boardLabels.map(function (label) {
        return [label.id, label];
      })
    );

    return labelIds
      .map(function (labelId) {
        return labelsById.get(labelId) || null;
      })
      .filter(Boolean);
  }

  async function closeCard(cardId, closed) {
    return api(`/cards/${cardId}`, {
      method: "PUT",
      query: {
        closed: closed ? "true" : "false"
      }
    });
  }

  async function updateCard(cardId, fields) {
    return api(`/cards/${cardId}`, {
      method: "PUT",
      query: fields
    });
  }

  async function createCard({ listId, name, desc, pos = "top" }) {
    return api("/cards", {
      method: "POST",
      query: {
        idList: listId,
        name,
        desc,
        pos
      }
    });
  }

  async function addCommentToCard(cardId, text) {
    if (!cardId || !text || !text.trim()) {
      return null;
    }

    return api(`/cards/${cardId}/actions/comments`, {
      method: "POST",
      query: {
        text: text.trim()
      }
    });
  }

  function buildNestedComment(parentCard) {
    const metadata = [];

    if (parentCard && parentCard.name) {
      metadata.push(`Nested into parent: ${parentCard.name}`);
    }
    if (parentCard && parentCard.url) {
      metadata.push(parentCard.url);
    }

    return metadata.join("\n");
  }

  async function getParentChoices(includeCurrentCard) {
    const ctx = await getCurrentContext();
    const parentIds = Object.keys(ctx.store.parentsById).filter((parentId) => {
      return includeCurrentCard || parentId !== ctx.card.id;
    });

    if (!parentIds.length) {
      return [];
    }

    const boardCards = await getBoardCards(ctx.board.id);
    const cardsById = new Map(boardCards.map((boardCard) => [boardCard.id, boardCard]));

    return parentIds
      .map((parentId) => cardsById.get(parentId))
      .filter(Boolean)
      .map((boardCard) => {
        const entry = getParentEntry(ctx.store, boardCard.id);
        return {
          ...boardCard,
          label: entry.label || boardCard.name,
          childCount: entry.childItems.length
        };
      });
  }

  async function setParentCard({ label }) {
    const ctx = await getCurrentContext();

    await updateStore((store) => {
      const parentEntry = ensureParentEntry(store, ctx.card.id);
      parentEntry.label = (label || "").trim() || parentEntry.label || ctx.card.name;
    });

    broadcastRefreshSignal("set-parent");
  }

async function addChildItemToParent(parentCardId, childInput) {
  const title = (childInput.title || "").trim();

  if (!title) {
    throw new Error("Nested card title is required.");
  }

  await updateStore((store) => {
    if (!store.parentsById[parentCardId]) {
      throw new Error("Choose a card that has already been set as a parent.");
    }

    const parentEntry = ensureParentEntry(store, parentCardId);
    parentEntry.childItems.unshift(buildStoredChildItem(childInput));
  });

  broadcastRefreshSignal("add-child");
}

async function storeCurrentCardInParent(parentCardId) {
  const ctx = await getCurrentContext();
  const sourceCard = await getBoardCard(ctx.card.id);
  const parentCard = await getBoardCard(parentCardId).catch(function () {
    return null;
  });

  if (ctx.card.id === parentCardId) {
    throw new Error("A parent card cannot nest itself.");
  }

  if (isParentCard(ctx.store, ctx.card.id)) {
    throw new Error("This card is already acting as a parent container.");
  }

  const existingEmbedding = findEmbeddedSource(ctx.store, ctx.card.id);
  if (existingEmbedding) {
    throw new Error("This card has already been stored inside a parent.");
  }

  await addChildItemToParent(parentCardId, {
    title: sourceCard.name || ctx.card.name,
    description: sourceCard.desc || ctx.card.desc || "",
    sourceCardId: sourceCard.id || ctx.card.id
  });

  const nestedComment = buildNestedComment(parentCard);
  if (nestedComment) {
    try {
      await addCommentToCard(ctx.card.id, nestedComment);
    } catch (error) {
      console.warn("Unable to add nested-card comment to card.", error);
    }
  }

  await closeCard(ctx.card.id, true);

  return parentCard;
}

  async function getEligibleListCardsForCurrentParent(listId) {
    const ctx = await getCurrentContext();
    const boardCards = await getBoardCards(ctx.board.id);
    const parentEntry = getParentEntry(ctx.store, ctx.card.id);
    const nestedSourceIds = new Set(
      (parentEntry.childItems || []).map((item) => item.sourceCardId).filter(Boolean)
    );

    return boardCards.filter((boardCard) => {
      if (boardCard.id === ctx.card.id) return false;
      if (boardCard.idList !== listId) return false;
      if (isParentCard(ctx.store, boardCard.id)) return false;
      if (nestedSourceIds.has(boardCard.id)) return false;
      if (findEmbeddedSource(ctx.store, boardCard.id)) return false;
      return true;
    });
  }

async function bulkStoreCardsInCurrentParent(cardIds, options = {}) {
  const ctx = await getCurrentContext();
  const selectedIds = new Set(cardIds || []);

  if (!selectedIds.size) {
    throw new Error("Select at least one card.");
  }

  const boardCards = await getBoardCards(ctx.board.id);
  const selectedCards = boardCards.filter((boardCard) => selectedIds.has(boardCard.id));

  if (!selectedCards.length) {
    throw new Error("No eligible cards were selected.");
  }

  await updateStore((store) => {
    if (!store.parentsById[ctx.card.id]) {
      throw new Error("This card is not set as a parent.");
    }

    const parentEntry = ensureParentEntry(store, ctx.card.id);
    const nestedSourceIds = new Set(
      (parentEntry.childItems || []).map((item) => item.sourceCardId).filter(Boolean)
    );

    for (const selectedCard of selectedCards) {
      if (selectedCard.id === ctx.card.id) continue;
      if (isParentCard(store, selectedCard.id)) continue;
      if (nestedSourceIds.has(selectedCard.id)) continue;
      if (findEmbeddedSource(store, selectedCard.id)) continue;

      parentEntry.childItems.unshift(
        buildStoredChildItem({
          title: selectedCard.name,
          description: selectedCard.desc || "",
          sourceCardId: selectedCard.id
        })
      );
    }
  });

  const nestedComment = buildNestedComment(ctx.card);
  await Promise.all(
    selectedCards.map(async function (selectedCard) {
      if (nestedComment) {
        try {
          await addCommentToCard(selectedCard.id, nestedComment);
        } catch (error) {
          console.warn("Unable to add nested-card comment to card.", error);
        }
      }

      await closeCard(selectedCard.id, true);
    })
  );

  broadcastRefreshSignal("bulk-add");
  return selectedCards;
}

  function buildRestoreComment(childItem, parentCard) {
    const metadata = [];
    if (parentCard && parentCard.name) {
      metadata.push(`Extracted from parent: ${parentCard.name}`);
    }
    if (parentCard && parentCard.url) {
      metadata.push(parentCard.url);
    }

    return metadata.join("\n");
  }

 async function restoreChildItemToBoard(childItem, parentCardId) {
  const parentCard = await getBoardCard(parentCardId);
  let restoredCard = null;

  if (childItem.sourceCardId) {
    try {
      restoredCard = await updateCard(childItem.sourceCardId, {
        idList: parentCard.idList,
        closed: "false",
        pos: "top"
      });
    } catch (error) {
      // Fall back to creating a new card if the original source card cannot be restored.
    }
  }

  if (!restoredCard) {
    restoredCard = await createCard({
      listId: parentCard.idList,
      name: childItem.title,
      desc: (childItem.description || "").trim()
    });
  }

  const restoreComment = buildRestoreComment(childItem, parentCard);
  if (restoreComment) {
    try {
      await addCommentToCard(restoredCard.id, restoreComment);
    } catch (error) {
      console.warn("Unable to add restore comment to card.", error);
    }
  }

  return restoredCard;
}

  async function extractChildToCard(parentCardId, childItemId) {
    const store = await getStore();
    const parentEntry = store.parentsById[parentCardId];
    if (!parentEntry) {
      throw new Error("The parent card could not be found.");
    }

    const childItem = (parentEntry.childItems || []).find((item) => item.id === childItemId) || null;
    if (!childItem) {
      throw new Error("That nested card no longer exists.");
    }

    const createdCard = await restoreChildItemToBoard(childItem, parentCardId);

    await removeChildItem(parentCardId, childItemId);
    return createdCard;
  }

  async function removeChildItem(parentCardId, childItemId) {
    await updateStore((store) => {
      const parentEntry = store.parentsById[parentCardId];
      if (!parentEntry) {
        throw new Error("The parent card could not be found.");
      }

      parentEntry.childItems = (parentEntry.childItems || []).filter((item) => item.id !== childItemId);
    });

    broadcastRefreshSignal("remove-child");
  }

  async function removeChildItems(parentCardId, childItemIds) {
    const idsToRemove = new Set(childItemIds);

    await updateStore((store) => {
      const parentEntry = store.parentsById[parentCardId];
      if (!parentEntry) {
        throw new Error("The parent card could not be found.");
      }

      parentEntry.childItems = (parentEntry.childItems || []).filter((item) => !idsToRemove.has(item.id));
    });

    broadcastRefreshSignal("remove-children");
  }

  async function extractAllChildrenToCards(parentCardId) {
    const store = await getStore();
    const parentEntry = store.parentsById[parentCardId];
    if (!parentEntry) {
      throw new Error("The parent card could not be found.");
    }

    const childItems = [...(parentEntry.childItems || [])];
    if (!childItems.length) {
      throw new Error("There are no nested cards to extract.");
    }

    const extractedIds = [];
    const createdCards = [];

    try {
      for (const childItem of childItems) {
        const createdCard = await restoreChildItemToBoard(childItem, parentCardId);
        extractedIds.push(childItem.id);
        createdCards.push(createdCard);
      }
    } finally {
      if (extractedIds.length) {
        await removeChildItems(parentCardId, extractedIds);
      }
    }

    return createdCards;
  }

  async function getCardSnapshot(targetT = getIframeContext()) {
    const ctx = await getCurrentContext(targetT);
    const parentEntry = ctx.store.parentsById[ctx.card.id];

    if (parentEntry) {
      return {
        role: "parent",
        board: ctx.board,
        card: ctx.card,
        parentState: normalizeParentEntry(ctx.card.id, parentEntry),
        sourceEmbedding: null
      };
    }

    const sourceEmbedding = findEmbeddedSource(ctx.store, ctx.card.id);
    let parentCard = null;

    if (sourceEmbedding) {
      parentCard = await getBoardCard(sourceEmbedding.parentCardId).catch(function () {
        return null;
      });
    }

    return {
      role: "regular",
      board: ctx.board,
      card: ctx.card,
      parentState: null,
      sourceEmbedding: sourceEmbedding
        ? {
            ...sourceEmbedding,
            parentCard
          }
        : null
    };
  }

  function renderMessage(el, kind, text) {
    if (!el) return;
    el.className = kind;
    el.textContent = text;
    requestFrameResize();
  }

  function createCardLink(card, label) {
    const link = document.createElement("a");
    link.href = card.url || `https://trello.com/c/${card.shortLink}`;
    link.target = "_blank";
    link.rel = "noreferrer";
    link.textContent = label || card.name;
    return link;
  }

  function createFieldLabel(text, inputId) {
    const label = document.createElement("label");
    label.textContent = text;
    if (inputId) {
      label.htmlFor = inputId;
    }
    return label;
  }

  function createTextPreview(text) {
    const preview = document.createElement("div");
    preview.className = "muted child-description";
    preview.textContent = text;
    return preview;
  }

async function hydrateChildItems(childItems, boardId) {
  return Promise.all(
    (childItems || []).map(async function (childItem) {
      const normalizedChild = normalizeStoredChildItem(childItem);

      if (!normalizedChild.sourceCardId) {
        return {
          ...normalizedChild,
          sourceCardLabels: []
        };
      }

      try {
        const sourceCard = await getBoardCard(normalizedChild.sourceCardId);
        const resolvedLabels = await resolveCardLabels(sourceCard, boardId);

        return {
          ...normalizedChild,
          title: sourceCard.name || normalizedChild.title,
          description: sourceCard.desc || normalizedChild.description || "",
          sourceCardLabels: resolvedLabels
        };
      } catch (error) {
        return {
          ...normalizedChild,
          sourceCardLabels: []
        };
      }
    })
  );
}

  function createLabelChip(label) {
    const chip = document.createElement("span");
    chip.className = `label-chip${label.color ? ` color-${label.color}` : " color-none"}`;
    chip.title = label.name || label.color || "Label";
    chip.textContent = label.name || " ";
    return chip;
  }

  function setElementHidden(element, hidden) {
    if (!element) return;
    element.hidden = hidden;
    element.style.display = hidden ? "none" : "";
    if (hidden) {
      element.setAttribute("aria-hidden", "true");
    } else {
      element.removeAttribute("aria-hidden");
    }
  }

  function openSignedPopup({ title, url, height, mouseEvent }) {
    const currentT = getIframeContext();
    return currentT.popup({
      title,
      url: currentT.signUrl(url),
      height,
      mouseEvent
    });
  }

  async function openParentCard(parentCard) {
    if (!parentCard) {
      return;
    }

    const currentT = getIframeContext();

    try {
      await currentT.hideCard();
    } catch (error) {
      // Continue and try to show the parent card anyway.
    }

    try {
      await currentT.showCard(parentCard.id);
      return;
    } catch (error) {
      // Fall back to URL navigation if showCard is unavailable in this context.
    }

    if (parentCard.url) {
      await currentT.navigate({ url: parentCard.url });
    }
  }

  async function renderSetParentPage() {
    const form = document.getElementById("set-parent-form");
    const labelInput = document.getElementById("parentLabel");
    const msg = document.getElementById("message");
    const authStatus = document.getElementById("auth-status");
    const authButton = document.getElementById("authorize-btn");
    const authRow = document.getElementById("auth-row");

    function refreshAuthUi() {
      const authorized = isAuthorized();
      setElementHidden(authStatus, authorized);
      setElementHidden(authRow, authorized);

      if (authStatus) {
        authStatus.textContent = "Authorize Trello to continue.";
      }
    }

    refreshAuthUi();

    authButton?.addEventListener("click", async function () {
      try {
        await authorizeWithTrello();
        refreshAuthUi();
        renderMessage(msg, "success", "Authorized.");
      } catch (error) {
        renderMessage(msg, "error", error.message || "Authorization failed.");
      }
    });

    const ctx = await getCurrentContext();
    const currentEntry = ctx.store.parentsById[ctx.card.id];
    if (currentEntry && currentEntry.label) {
      labelInput.value = currentEntry.label;
    } else {
      labelInput.value = ctx.card.name || "";
    }

    form?.addEventListener("submit", async function (event) {
      event.preventDefault();

      try {
        await setParentCard({ label: labelInput.value.trim() });
        renderMessage(msg, "success", "Saved.");
        setTimeout(function () {
          getIframeContext().closePopup();
        }, 700);
      } catch (error) {
        renderMessage(msg, "error", error.message || "Unable to update the card.");
      }
    });
  }

  async function renderAttachChildPage() {
    const form = document.getElementById("attach-child-form");
    const parentPickerInput = document.getElementById("parentPickerInput");
    const parentCardIdInput = document.getElementById("parentCardId");
    const parentPickerMenu = document.getElementById("parentPickerMenu");
    const msg = document.getElementById("message");
    const authStatus = document.getElementById("auth-status");
    const authButton = document.getElementById("authorize-btn");
    const refreshButton = document.getElementById("refresh-parents-btn");
    const authRow = document.getElementById("auth-row");
    let parentChoices = [];
    let selectedParentId = "";

    function getFilteredParents() {
      const searchTerm = (parentPickerInput?.value || "").trim().toLowerCase();
      return parentChoices.filter((parent) => {
        if (!searchTerm) return true;
        return `${parent.label} ${parent.name} ${parent.shortLink || ""}`.toLowerCase().includes(searchTerm);
      });
    }

    function closeParentMenu() {
      setElementHidden(parentPickerMenu, true);
    }

    function selectParent(parent) {
      selectedParentId = parent ? parent.id : "";
      if (parentCardIdInput) {
        parentCardIdInput.value = selectedParentId;
      }
      if (parentPickerInput) {
        parentPickerInput.value = parent ? parent.label : "";
      }
      closeParentMenu();
    }

    function renderParentOptions() {
      if (!parentPickerMenu) {
        return;
      }

      parentPickerMenu.innerHTML = "";
      const filteredParents = getFilteredParents();

      if (!parentChoices.length) {
        const empty = document.createElement("button");
        empty.type = "button";
        empty.className = "combobox-option empty";
        empty.textContent = "No parent cards yet.";
        empty.disabled = true;
        parentPickerMenu.appendChild(empty);
        setElementHidden(parentPickerMenu, false);
        return;
      }

      if (!filteredParents.length) {
        const empty = document.createElement("button");
        empty.type = "button";
        empty.className = "combobox-option empty";
        empty.textContent = "No parents match that search.";
        empty.disabled = true;
        parentPickerMenu.appendChild(empty);
        setElementHidden(parentPickerMenu, false);
        return;
      }

      for (const parent of filteredParents) {
        const option = document.createElement("button");
        option.type = "button";
        option.className = "combobox-option";
        option.textContent = parent.label;
        option.addEventListener("mousedown", function (event) {
          event.preventDefault();
          selectParent(parent);
        });
        parentPickerMenu.appendChild(option);
      }

      setElementHidden(parentPickerMenu, false);
    }

    async function loadParents() {
      parentChoices = await getParentChoices(false);
      renderParentOptions();
    }

    function refreshAuthUi() {
      const authorized = isAuthorized();
      setElementHidden(authStatus, authorized);
      setElementHidden(authRow, authorized);

      if (authStatus) {
        authStatus.textContent = "Authorize Trello to continue.";
      }
    }

    refreshAuthUi();

    authButton?.addEventListener("click", async function () {
      try {
        await authorizeWithTrello();
        refreshAuthUi();
        await loadParents();
        renderMessage(msg, "success", "Authorized.");
      } catch (error) {
        renderMessage(msg, "error", error.message || "Authorization failed.");
      }
    });

    refreshButton?.addEventListener("click", async function () {
      try {
        await loadParents();
        renderMessage(msg, "success", "Refreshed.");
      } catch (error) {
        renderMessage(msg, "error", error.message || "Unable to refresh card list.");
      }
    });

    parentPickerInput?.addEventListener("focus", function () {
      renderParentOptions();
      requestFrameResize();
    });

    parentPickerInput?.addEventListener("input", function () {
      selectedParentId = "";
      if (parentCardIdInput) {
        parentCardIdInput.value = "";
      }
      renderParentOptions();
      requestFrameResize();
    });

    parentPickerInput?.addEventListener("blur", function () {
      window.setTimeout(closeParentMenu, 120);
    });

    document.addEventListener("click", function (event) {
      if (!parentPickerInput || !parentPickerMenu) {
        return;
      }

      const target = event.target;
      if (!(target instanceof Node)) {
        return;
      }

      if (parentPickerInput.contains(target) || parentPickerMenu.contains(target)) {
        return;
      }

      closeParentMenu();
    });

    if (isAuthorized()) {
      await loadParents();
    }

    form?.addEventListener("submit", async function (event) {
      event.preventDefault();

      const parentCardId = selectedParentId || (parentCardIdInput ? parentCardIdInput.value : "");
      if (!parentCardId) {
        renderMessage(msg, "error", "Select a parent card first.");
        return;
      }

      try {
        const parentCard = await storeCurrentCardInParent(parentCardId);

        renderMessage(
          msg,
          "success",
          parentCard
            ? `Nested into ${parentCard.name}.`
            : "Nested."
        );

        setTimeout(function () {
          openParentCard(parentCard).catch(function (error) {
            console.error(error);
            getIframeContext().closePopup();
          });
        }, 800);
      } catch (error) {
        renderMessage(msg, "error", error.message || "Unable to store this card inside a parent.");
      }
    });
  }

  async function renderBulkAddPage() {
    const form = document.getElementById("bulk-add-form");
    const listSelect = document.getElementById("bulk-list-id");
    const cardsWrap = document.getElementById("bulk-card-list");
    const msg = document.getElementById("message");
    const authStatus = document.getElementById("auth-status");
    const authButton = document.getElementById("authorize-btn");
    const authRow = document.getElementById("auth-row");
    const refreshButton = document.getElementById("refresh-cards-btn");

    async function loadListsAndCards() {
      const ctx = await getCurrentContext();
      const lists = await getBoardLists(ctx.board.id);

      if (listSelect && !listSelect.options.length) {
        for (const list of lists) {
          const option = document.createElement("option");
          option.value = list.id;
          option.textContent = list.name;
          option.selected = list.id === ctx.card.idList;
          listSelect.appendChild(option);
        }
      }

      await loadCards(listSelect?.value || ctx.card.idList);
    }

    async function loadCards(listId) {
      const cards = await getEligibleListCardsForCurrentParent(listId);

      if (!cardsWrap) {
        return;
      }

      cardsWrap.innerHTML = "";

      if (!cards.length) {
        const empty = document.createElement("div");
        empty.className = "empty-state panel-card";
        empty.textContent = "No cards available in this list.";
        cardsWrap.appendChild(empty);
        return;
      }

      for (const card of cards) {
        const label = document.createElement("label");
        label.className = "checkbox-card";

        const input = document.createElement("input");
        input.type = "checkbox";
        input.name = "cardIds";
        input.value = card.id;
        label.appendChild(input);

        const textWrap = document.createElement("div");
        textWrap.className = "stack compact-text";

        const title = document.createElement("strong");
        title.textContent = card.name;
        textWrap.appendChild(title);

        label.appendChild(textWrap);
        cardsWrap.appendChild(label);
      }
    }

    function refreshAuthUi() {
      const authorized = isAuthorized();
      setElementHidden(authStatus, authorized);
      setElementHidden(authRow, authorized);

      if (authStatus) {
        authStatus.textContent = "Authorize Trello to continue.";
      }
    }

    refreshAuthUi();

    authButton?.addEventListener("click", async function () {
      try {
        await authorizeWithTrello();
        refreshAuthUi();
        await loadCards();
        renderMessage(msg, "success", "Authorized.");
      } catch (error) {
        renderMessage(msg, "error", error.message || "Authorization failed.");
      }
    });

    refreshButton?.addEventListener("click", async function () {
      try {
        await loadCards(listSelect?.value);
        renderMessage(msg, "success", "Refreshed.");
      } catch (error) {
        renderMessage(msg, "error", error.message || "Unable to refresh cards.");
      }
    });

    listSelect?.addEventListener("change", async function () {
      try {
        await loadCards(listSelect.value);
      } catch (error) {
        renderMessage(msg, "error", error.message || "Unable to load cards for this list.");
      }
    });

    if (isAuthorized()) {
      await loadListsAndCards();
    }

    form?.addEventListener("submit", async function (event) {
      event.preventDefault();

      const selectedIds = Array.from(
        document.querySelectorAll('input[name="cardIds"]:checked')
      ).map((input) => input.value);

      try {
        const selectedCards = await bulkStoreCardsInCurrentParent(selectedIds);

        renderMessage(
          msg,
          "success",
          `Added ${selectedCards.length} card${selectedCards.length === 1 ? "" : "s"}.`
        );

        setTimeout(function () {
          getIframeContext().closePopup();
        }, 800);
      } catch (error) {
        renderMessage(msg, "error", error.message || "Unable to add selected cards.");
      }
    });
  }

  async function renderGroupPanel() {
    const root = document.getElementById("group-panel-root");
    const actions = document.getElementById("group-panel-actions");
    const msg = document.getElementById("message");

    if (!root || !actions) return;

    const snapshot = await getCardSnapshot();
    root.innerHTML = "";
    actions.innerHTML = "";
    root.className = "stack panel-root";

    if (snapshot.role !== "parent") {
      const stateCard = document.createElement("div");
      stateCard.className = "panel-card stack";

      const setupActions = document.createElement("div");
      setupActions.className = "row wrap action-cluster";

      const setParentButton = document.createElement("button");
      setParentButton.className = "primary";
      setParentButton.type = "button";
      setParentButton.textContent = "Set as Parent";
      setParentButton.addEventListener("click", async function (event) {
        try {
          await openSignedPopup({
            title: "Set as Parent",
            url: "./set-parent.html",
            height: 260,
            mouseEvent: event
          });
        } catch (error) {
          renderMessage(msg, "error", error.message || "Unable to open the parent setup form.");
        }
      });
      setupActions.appendChild(setParentButton);

      const nestCardButton = document.createElement("button");
      nestCardButton.className = "secondary";
      nestCardButton.type = "button";
      nestCardButton.textContent = "Nest Card";
      nestCardButton.addEventListener("click", async function (event) {
        try {
          await openSignedPopup({
            title: "Nest This Card",
            url: "./attach-child.html",
            height: 420,
            mouseEvent: event
          });
        } catch (error) {
          renderMessage(msg, "error", error.message || "Unable to open the nesting form.");
        }
      });
      setupActions.appendChild(nestCardButton);

      stateCard.appendChild(setupActions);

      if (snapshot.sourceEmbedding && snapshot.sourceEmbedding.parentCard) {
        const storedCard = document.createElement("div");
        storedCard.className = "list-item child-card stack";

        const heading = document.createElement("strong");
        heading.textContent = "Already stored inside";
        storedCard.appendChild(heading);
        storedCard.appendChild(createCardLink(snapshot.sourceEmbedding.parentCard));

        const childName = document.createElement("div");
        childName.className = "muted";
        childName.textContent = `Nested card: ${snapshot.sourceEmbedding.childItem.title}`;
        storedCard.appendChild(childName);

        stateCard.appendChild(storedCard);
      }
      root.appendChild(stateCard);
      requestFrameResize();
      return;
    }

    const childItems = await hydrateChildItems(snapshot.parentState.childItems, snapshot.board.id);

    const top = document.createElement("div");
    top.className = "hero-card stack";

    const badgeRow = document.createElement("div");
    badgeRow.className = "row wrap status-row";

    const roleBadge = document.createElement("div");
    roleBadge.className = "badge";
    roleBadge.textContent = "Parent container";
    badgeRow.appendChild(roleBadge);

    const countBadge = document.createElement("div");
    countBadge.className = "badge";
    countBadge.textContent = `${snapshot.parentState.childItems.length} nested card${
      snapshot.parentState.childItems.length === 1 ? "" : "s"
    }`;
    badgeRow.appendChild(countBadge);

    if (snapshot.parentState.label) {
      const labelBadge = document.createElement("div");
      labelBadge.className = "badge";
      labelBadge.textContent = snapshot.parentState.label;
      badgeRow.appendChild(labelBadge);
    }

    top.appendChild(badgeRow);

    const topActions = document.createElement("div");
    topActions.className = "row wrap action-cluster";

    const bulkAddButton = document.createElement("button");
    bulkAddButton.className = "primary";
    bulkAddButton.type = "button";
    bulkAddButton.textContent = "Add from List";
    bulkAddButton.addEventListener("click", async function (event) {
      try {
        await openSignedPopup({
          title: "Add from List",
          url: "./bulk-add.html",
          height: 520,
          mouseEvent: event
        });
      } catch (error) {
        renderMessage(msg, "error", error.message || "Unable to open the bulk add form.");
      }
    });
    topActions.appendChild(bulkAddButton);

    top.appendChild(topActions);

    root.appendChild(top);

    const childListHead = document.createElement("div");
    childListHead.className = "row wrap space-between list-header";

    const childListTitle = document.createElement("h3");
    childListTitle.className = "section-title";
    childListTitle.textContent = "Nested Cards";
    childListHead.appendChild(childListTitle);

    const extractAllButton = document.createElement("button");
    extractAllButton.className = "secondary strong-action";
    extractAllButton.type = "button";
    extractAllButton.textContent = "Extract All";
    extractAllButton.disabled = snapshot.parentState.childItems.length === 0;
    extractAllButton.addEventListener("click", async function () {
      try {
        const createdCards = await extractAllChildrenToCards(snapshot.card.id);
        renderMessage(
          msg,
          "success",
          `Restored ${createdCards.length} card${createdCards.length === 1 ? "" : "s"}.`
        );
        await renderGroupPanel();
      } catch (error) {
        renderMessage(msg, "error", error.message || "Unable to extract all nested cards.");
      }
    });
    childListHead.appendChild(extractAllButton);

    root.appendChild(childListHead);

    if (!childItems.length) {
      const empty = document.createElement("div");
      empty.className = "panel-card empty-state";
      empty.textContent = "No nested cards yet.";
      root.appendChild(empty);
      return;
    }

    const childList = document.createElement("div");
    childList.className = "list";

    for (const childItem of childItems) {
      const item = document.createElement("div");
      item.className = "list-item child-card stack";

      const headingRow = document.createElement("div");
      headingRow.className = "row wrap space-between";

      const title = document.createElement("strong");
      title.textContent = childItem.title;
      headingRow.appendChild(title);

      item.appendChild(headingRow);

      if ((childItem.sourceCardLabels || []).length) {
        const labelRow = document.createElement("div");
        labelRow.className = "label-row";

        for (const label of childItem.sourceCardLabels) {
          labelRow.appendChild(createLabelChip(label));
        }

        item.appendChild(labelRow);
      }

      if (childItem.description) {
        item.appendChild(createTextPreview(childItem.description));
      }

      const buttonRow = document.createElement("div");
      buttonRow.className = "row wrap";

      const extractButton = document.createElement("button");
      extractButton.className = "primary";
      extractButton.type = "button";
      extractButton.textContent = "Restore";
      extractButton.addEventListener("click", async function () {
        try {
          const createdCard = await extractChildToCard(snapshot.card.id, childItem.id);
          renderMessage(msg, "success", `Restored to board: ${createdCard.name}`);
          await renderGroupPanel();
        } catch (error) {
          renderMessage(msg, "error", error.message || "Unable to restore this nested card.");
        }
      });
      buttonRow.appendChild(extractButton);

      item.appendChild(buttonRow);
      childList.appendChild(item);
    }

    root.appendChild(childList);
    requestFrameResize();
  }

  async function renderAuthPage() {
    const msg = document.getElementById("auth-message");
    const hash = window.location.hash.replace(/^#/, "");
    const params = new URLSearchParams(hash);
    const token = params.get("token");

    if (!token) {
      msg.textContent = "No token was returned by Trello.";
      return;
    }

    setStoredToken(token);

    if (window.opener && typeof window.opener.authorize === "function") {
      window.opener.authorize(token);
      msg.textContent = "Authorization complete. You can close this window.";
      window.close();
      return;
    }

    msg.textContent = "Authorization complete. Return to the Trello popup.";
  }

  function initConnector() {
    if (!T || !T.initialize) return;

    T.initialize({
      "card-buttons": function (localT) {
        return [
          {
            icon: `${CONFIG.appUrl.replace(/\/$/, "")}/icon_144px.png`,
            text: "Set as Parent",
            callback: function (cbT) {
              return cbT.popup({
                title: "Set as Parent",
                url: cbT.signUrl("./set-parent.html"),
                height: 260
              });
            }
          },
          {
            icon: `${CONFIG.appUrl.replace(/\/$/, "")}/icon_144px.png`,
            text: "Nest This Card",
            callback: function (cbT) {
              return cbT.popup({
                title: "Nest This Card",
                url: cbT.signUrl("./attach-child.html"),
                height: 420
              });
            }
          }
        ];
      },
      "card-back-section": function (localT) {
        return {
          title: "Card Nesting",
          icon: `${CONFIG.appUrl.replace(/\/$/, "")}/icon_144px.png`,
          content: {
            type: "iframe",
            url: localT.signUrl("./group-panel.html"),
            height: 260
          }
        };
      }
    });
  }

  async function main() {
    ensureConfig();
    const page = document.body.dataset.page;

    if (page === "connector") {
      initConnector();
      return;
    }

    if (T && typeof T.iframe === "function") {
      try {
        getIframeContext().render(function () {
          requestFrameResize();
        });
        watchFrameSize();
      } catch (error) {
        // Ignore render registration failures outside standard Trello iframe pages.
      }
    }

    if (page === "set-parent") {
      await renderSetParentPage();
      requestFrameResize();
      return;
    }

    if (page === "attach-child") {
      await renderAttachChildPage();
      requestFrameResize();
      return;
    }

    if (page === "bulk-add") {
      await renderBulkAddPage();
      requestFrameResize();
      return;
    }

    if (page === "group-panel") {
      const rerenderGroupPanel = function () {
        renderGroupPanel().catch(function (error) {
          console.error(error);
          const msg = document.getElementById("message");
          if (msg) {
            renderMessage(msg, "error", error.message || "Unable to refresh the card view.");
          }
        });
      };

      window.addEventListener("focus", function () {
        window.setTimeout(rerenderGroupPanel, 100);
      });

      window.addEventListener("storage", function (event) {
        if (event.key === REFRESH_SIGNAL_KEY) {
          rerenderGroupPanel();
        }
      });

      document.addEventListener("visibilitychange", function () {
        if (!document.hidden) {
          window.setTimeout(rerenderGroupPanel, 100);
        }
      });

      await renderGroupPanel();
      return;
    }

    if (page === "auth") {
      await renderAuthPage();
    }
  }

  window.CardNestingPowerUp = {
    authorizeWithTrello,
    clearStoredToken,
    getStoredToken,
    getCardSnapshot,
    setParentCard,
    addChildItemToParent,
    storeCurrentCardInParent,
    bulkStoreCardsInCurrentParent,
    extractChildToCard,
    extractAllChildrenToCards
  };

  window.addEventListener("DOMContentLoaded", function () {
    main().catch(function (error) {
      console.error(error);
      const msg = document.getElementById("message") || document.getElementById("auth-message");
      if (msg) {
        msg.className = "error";
        msg.textContent = error.message || "Unexpected error";
      }
    });
  });
})();
