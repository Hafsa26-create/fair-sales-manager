(() => {
    // ========================================
    // 1. DOM, CONFIGURATION & APP STATE
    // ========================================

    const $ = (id) => document.getElementById(id);

    // Owner navigation works as a menu: selecting a section hides the menu
    // and every other section. Each section loads its data only when first opened.
    let activeOwnerPage = null;
    const ownerSectionLoadPromises = new Map();

    function showOwnerPage(page) {
        const pages = ["dashboard", "sales-activity", "employee-sales", "fair-sales", "total-sales", "products", "employees", "finance", "personal", "settings"];
        const selected = pages.includes(page) ? page : null;
        activeOwnerPage = selected;
        const backButton = document.getElementById("ownerBackToSections");

        if (ownerNavigation) ownerNavigation.classList.toggle("hidden", Boolean(selected));
        if (backButton) backButton.classList.toggle("hidden", !selected);

        document.querySelectorAll("#owner > [data-owner-page]").forEach((element) => {
            element.classList.toggle("hidden", !selected || element.dataset.ownerPage !== selected);
        });
        document.querySelectorAll("#ownerNavigation [data-owner-page]").forEach((button) => {
            const active = button.dataset.ownerPage === selected;
            button.classList.toggle("active", active);
            if (active) button.setAttribute("aria-current", "page");
            else button.removeAttribute("aria-current");
        });
    }

    const ownerNavigation = document.getElementById("ownerNavigation");
    if (ownerNavigation) {
        const backButton = document.createElement("button");
        backButton.type = "button";
        backButton.id = "ownerBackToSections";
        backButton.className = "owner-back-button hidden";
        backButton.textContent = "← Back to Sections";
        backButton.addEventListener("click", () => showOwnerPage(null));
        ownerNavigation.insertAdjacentElement("afterend", backButton);

        ownerNavigation.addEventListener("click", (event) => {
            const button = event.target.closest("[data-owner-page]");
            if (!button) return;
            const page = button.dataset.ownerPage;
            showOwnerPage(page);
            if (role === "owner") safe(() => loadOwnerSection(page));
        });
    }
    // Start with the navigation menu only; a section opens after it is selected.
    showOwnerPage(null);

    const cfg = window.FAIR_APP_CONFIG;
    let S = window.supabase;

    let db;
    let clientReadyPromise;
    let resolveClientReady;
    let rejectClientReady;
    clientReadyPromise = new Promise((resolve, reject) => {
        resolveClientReady = resolve;
        rejectClientReady = reject;
    });
    clientReadyPromise.catch(() => {});
    let user;
    let activeUserId = null;
    let mode = "login";

    let fair = null;
    let finance = null;
    let role = null;

    let fairs = [];
    let products = [];
    let sales = [];
    let expenses = [];
    let globalCatalog = [];
    let globalInventory = [];
    let globalPurchaseTotal = 0;
    let stockAdjustmentRows = [];
    let editingStockAdjustmentId = null;
    let salesPage = 0;
    let expensesPage = 0;
    let selectedEmployeeSheetId = null;
    const REPORT_PAGE_SIZE = 50;
    let channel = null;


    // ========================================
    // 2. COMMON HELPERS
    // ========================================

    const money = (n) =>
        "৳" + Number(n || 0).toLocaleString("en-BD", {
            maximumFractionDigits: 2
        });

    const esc = (s) =>
        String(s ?? "").replace(/[&<>"']/g, (c) => ({
            "&": "&amp;",
            "<": "&lt;",
            ">": "&gt;",
            '"': "&quot;",
            "'": "&#39;"
        })[c]);

    const day = (s) => String(s || "").slice(0, 10);

    function msg(s, error = false) {
        const t = $("toast");

        t.textContent = s;
        t.classList.toggle("error", error);
        t.classList.remove("hidden");

        setTimeout(() => t.classList.add("hidden"), 4000);
    }

    async function data(p) {
        const { data, error } = await p;

        if (error) {
            throw error;
        }

        return data;
    }

    async function safe(fn) {
        try {
            await fn();
        } catch (e) {
            console.error(e);
            msg(e.message || "Something went wrong.", true);
        }
    }

    function isNetworkError(error) {
        const message = String(error?.message || "").toLowerCase();
        return error instanceof TypeError ||
            error?.name === "FetchError" ||
            error?.status === 0 ||
            error?.code === "PGRST000" ||
            [
                "failed to fetch",
                "networkerror",
                "network request failed",
                "load failed",
                "fetch failed"
            ].some((phrase) => message.includes(phrase));
    }



    // ========================================
    // OFFLINE STORAGE & SALES SYNC
    // ========================================

    const OFFLINE_DB = "fair-sales-offline";
    const OFFLINE_VERSION = 1;

    function openOfflineDB() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(OFFLINE_DB, OFFLINE_VERSION);

            request.onupgradeneeded = () => {
                const store = request.result;
                if (!store.objectStoreNames.contains("snapshots")) {
                    store.createObjectStore("snapshots", { keyPath: "userId" });
                }
                if (!store.objectStoreNames.contains("pendingSales")) {
                    store.createObjectStore("pendingSales", { keyPath: "id" });
                }
            };

            request.onblocked = () => reject(new Error("Offline storage is busy in another app tab. Close other tabs and retry."));
            request.onsuccess = () => {
                const db = request.result;
                db.onversionchange = () => db.close();
                resolve(db);
            };
            request.onerror = () => reject(request.error || new Error("Could not open offline storage."));
        });
    }

    async function offlineRequest(storeName, mode, action) {
        const offlineDB = await openOfflineDB();
        return new Promise((resolve, reject) => {
            let tx;
            let request;
            try {
                tx = offlineDB.transaction(storeName, mode);
                const store = tx.objectStore(storeName);
                request = action(store);
            } catch (error) {
                offlineDB.close();
                reject(error);
                return;
            }
            tx.oncomplete = () => {
                offlineDB.close();
                resolve(request?.result);
            };
            tx.onerror = () => {
                offlineDB.close();
                reject(tx.error || request?.error);
            };
            tx.onabort = () => {
                offlineDB.close();
                reject(tx.error || new Error("Offline storage transaction failed."));
            };
        });
    }

    const saveSnapshot = (snapshot) =>
        offlineRequest("snapshots", "readwrite", store => store.put(snapshot));

    const getSnapshot = (userId) =>
        offlineRequest("snapshots", "readonly", store => store.get(userId));

    const savePendingSale = (sale) =>
        offlineRequest("pendingSales", "readwrite", store => store.put(sale));

    const getPendingSales = () =>
        offlineRequest("pendingSales", "readonly", store => store.getAll());

    const removePendingSale = (id) =>
        offlineRequest("pendingSales", "readwrite", store => store.delete(id));

    // Identify queued sales for fairs that are no longer assigned to this
    // account. Never delete these automatically: the queue may contain genuine
    // sales entered offline before an employee was removed from a fair.
    async function countPendingSalesForUnassignedFairs(validFairIds) {
        if (!user) return 0;
        const validIds = new Set(validFairIds);
        const pending = await getPendingSales();
        return pending.filter(item =>
            item.entered_by === user.id && !validIds.has(item.fair_id)
        ).length;
    }

    // Destructive cleanup is available only after the user explicitly confirms.
    async function removePendingSalesForDeletedFairs(validFairIds) {
        if (!user || !navigator.onLine) return 0;
        const validIds = new Set(validFairIds);
        const pending = await getPendingSales();
        const stale = pending.filter(item =>
            item.entered_by === user.id && !validIds.has(item.fair_id)
        );
        for (const sale of stale) await removePendingSale(sale.id);
        return stale.length;
    }

    let syncingSales = false;
    let syncRetryTimer = null;
    let lastSyncError = "";
    let lastCleanedPendingCount = 0;

    async function updatePendingStatus() {
        const pending = await getPendingSales();
        const count = pending.filter(item => item.entered_by === user?.id).length;
        const syncLabel = $("sync");
        if (syncLabel) {
            syncLabel.textContent = count
                ? (navigator.onLine ? `● ${count} pending — retrying` : `● ${count} pending — offline`)
                : navigator.onLine ? "● Online" : "● Offline";
            if (count && lastSyncError) {
                syncLabel.title = "Last sync error: " + lastSyncError;
            } else {
                syncLabel.removeAttribute("title");
            }
        }
        return count;
    }

    async function syncPendingSales() {
        if (syncingSales || !navigator.onLine || !user) {
            try {
                await updatePendingStatus();
            } catch (error) {
                console.warn("Could not read offline sync status:", error);
            }
            return;
        }

        syncingSales = true;
        lastSyncError = "";
        try {
            const pending = await getPendingSales();
            const assignedFairIds = new Set(fairs.map(item => item.id));
            const mine = pending.filter(item =>
                item.entered_by === user.id && assignedFairIds.has(item.fair_id)
            );
            let syncedCount = 0;
            const failedSales = [];

            // Process each queued sale independently. One stale/deleted fair must
            // not block valid sales from a different, currently assigned fair.
            for (const sale of mine) {
                try {
                    // Pending records are new sales. Use INSERT rather than UPSERT:
                    // the employee has no UPDATE policy on sales entries, and an
                    // UPSERT can enter the UPDATE/RLS path on conflict.
                    const { error } = await db
                        .from("fair_sales_entries")
                        .insert(sale);

                    // A duplicate UUID means an earlier attempt reached the server
                    // but its response was lost. Treat that idempotently as synced.
                    if (error && error.code !== "23505") throw error;
                    await removePendingSale(sale.id);
                    syncedCount += 1;
                } catch (saleError) {
                    failedSales.push({ sale, error: saleError });
                    console.warn("Pending sale could not sync; keeping it on this device:", sale.id, saleError);
                }
            }

            if (syncedCount && fair && role === "owner") {
                await report();
            } else if (syncedCount && fair && role === "employee") {
                await refreshEmployeeItemsSold();
            }

            if (failedSales.length) {
                lastSyncError = failedSales[0].error?.message || String(failedSales[0].error);
                const detail = lastSyncError.length > 110
                    ? lastSyncError.slice(0, 107) + "..."
                    : lastSyncError;
                if ($("entryStatus")) {
                    $("entryStatus").textContent =
                        (syncedCount ? syncedCount + " sale(s) synced. " : "") +
                        failedSales.length + " sale(s) still pending. First error: " + detail +
                        ". Failed sales remain saved on this phone.";
                }
                if ($("sync")) $("sync").textContent = "● Some sales still pending";
            } else if (syncedCount) {
                lastSyncError = "";
                if ($("entryStatus")) $("entryStatus").textContent = "All pending sales synced.";
                msg("Offline sales synced successfully.");
            }

            await updatePendingStatus();
        } catch (error) {
            lastSyncError = error?.message || String(error);
            console.error("Offline sales sync failed; pending records retained:", error);
            if ($("sync")) $("sync").textContent = "● Sync pending — retrying";
            const detail = lastSyncError.length > 110
                ? lastSyncError.slice(0, 107) + "..."
                : lastSyncError;
            if ($("entryStatus")) {
                $("entryStatus").textContent = "SYNC ERROR — " + detail +
                    ". Your pending sales are still saved on this phone. Tap Retry Sync after checking the connection.";
            }
        } finally {
            syncingSales = false;
            try {
                await updatePendingStatus();
            } catch (statusError) {
                console.warn("Could not refresh offline sync status:", statusError);
            }
        }
    }


    // ========================================
    // 3. AUTHENTICATION UI
    // ========================================

    function setMode(m) {
        mode = m;

        $("loginTab").classList.toggle("active", m === "login");
        $("signupTab").classList.toggle("active", m === "signup");

        $("authbtn").textContent =
            m === "login" ? "Sign in" : "Create account";
    }

    function appView(on) {
        $("auth").classList.toggle("hidden", on);
        $("app").classList.toggle("hidden", !on);
        $("out").classList.toggle("hidden", !on);
    }

    async function startSession(session) {
        const nextUser = session?.user || null;

        if (!nextUser) {
            user = null;
            activeUserId = null;

            if (channel) {
                await db.removeChannel(channel);
                channel = null;
            }

            appView(false);
            return;
        }

        if (activeUserId === nextUser.id) {
            return;
        }

        user = nextUser;
        activeUserId = nextUser.id;

        appView(true);

        $("welcome").textContent =
            (user.email || "Welcome").split("@")[0];

        try {
            await loadFairs();
            await syncPendingSales();
        } catch (error) {
            activeUserId = null;
            throw error;
        }
    }


    // ========================================
    // 4. FAIR LOADING & SELECTION
    // ========================================

    async function loadFairs() {
        try {
            // Fair records and the current user's memberships are independent;
            // fetch them together instead of waiting for two network round trips.
            const [remoteFairs, ms] = await Promise.all([
                data(db.from("fair_sales_fairs").select("*").order("created_at", { ascending: false })),
                data(db.from("fair_sales_memberships").select("fair_id,role").eq("user_id", user.id))
            ]);
            const roles = new Map(ms.map((m) => [m.fair_id, m.role]));
            fairs = remoteFairs.filter((f) => roles.has(f.id)).map((f) => ({
                ...f,
                role: roles.get(f.id)
            }));
            // Keep queued sales from removed/deleted fairs for review. Never purge
            // potentially genuine offline sales during an ordinary login/refresh.
            lastCleanedPendingCount = await countPendingSalesForUnassignedFairs(fairs.map(item => item.id));
            const previous = await getSnapshot(user.id);
            const selectedFairId = fairs.some(item => item.id === previous?.selectedFairId)
                ? previous.selectedFairId
                : fairs[0]?.id || null;
            await saveSnapshot({
                userId: user.id,
                fairs,
                selectedFairId,
                productsByFair: previous?.productsByFair || {}
            });
        } catch (networkError) {
            if (!isNetworkError(networkError) && navigator.onLine) throw networkError;
            const snapshot = await getSnapshot(user.id);
            if (!snapshot?.fairs?.length) throw networkError;
            fairs = snapshot.fairs;
            msg("Offline mode: using fairs saved on this device.");
        }

            
const manageFairSelect = $("manageFairSelect");

if (manageFairSelect) {
    manageFairSelect.innerHTML = fairs.length
        ? '<option value="">Choose a fair</option>' +
          fairs
              .map(
                  (f) =>
                      `<option value="${f.id}">${esc(f.name)}</option>`
              )
              .join("")
        : '<option value="">No fair available</option>';
}


        $("fairSelect").innerHTML = fairs.length
            ? fairs
                .map(
                    (f) =>
                        `<option value="${f.id}">${esc(f.name)}</option>`
                )
                .join("")
            : '<option value="">No fair assigned yet</option>';
if (!fairs.length) {
    fair = null;

    const { data: isOwner, error: ownerError } =
        await db.rpc("fair_sales_is_existing_owner");

    if (ownerError) {
        console.error("Owner check failed:", ownerError);
        role = null;
        toggle();

        $("nofair").textContent =
            "Could not verify owner access. Please refresh and sign in again.";

        return;
    }

    role = isOwner === true ? "owner" : null;

    toggle();

    $("nofair").textContent = role === "owner"
        ? "No fair created yet. You can create a new fair below."
        : "No fair assigned. Ask the owner to add your account.";

    if (role === "owner") await loadGlobalInventory();

    return;
}
        const snapshot = await getSnapshot(user.id);
        const selectedFairId = fairs.some(item => item.id === snapshot?.selectedFairId)
            ? snapshot.selectedFairId
            : fairs[0].id;

        $("fairSelect").value = selectedFairId;
        await chooseFair(selectedFairId);
    }

    function toggle() {
        $("employee").classList.toggle(
            "hidden",
            role !== "employee" || !fair
        );

       $("owner").classList.toggle(
         "hidden",
          role !== "owner"
        );

        $("role").textContent =
            role === "owner"
                ? "OWNER WORKSPACE"
                : role === "employee"
                    ? "EMPLOYEE SALES"
                    : "WORKSPACE";

        $("subtitle").textContent = fair
            ? `${fair.name} · ${day(fair.start_date)} to ${day(fair.end_date)}`
            : "Create a fair or ask the owner to add you.";

        $("nofair").textContent = fair
            ? ""
            : "No fair selected.";
    }

    async function syncGlobalPriceCodesToFair(fairId) {
        if (role !== "owner" || !fairId) return;

        const catalog = await data(
            db.from("fair_sales_price_codes")
                .select("product_code,buying_price,default_selling_price,display_name")
                .order("product_code")
        );

        await Promise.all(catalog.map(async (item) => {
            const productId = await data(
                db.rpc("fair_sales_add_price_code", {
                    p_fair_id: fairId,
                    p_buying_price: Number(item.buying_price),
                    p_product_code: item.product_code
                })
            );
            const productUpdate = {};
            if (item.default_selling_price !== null && item.default_selling_price !== undefined) {
                productUpdate.default_selling_price = Number(item.default_selling_price);
            }
            productUpdate.display_name = item.display_name || null;
            await data(
                db.from("fair_sales_products")
                    .update(productUpdate)
                    .eq("id", productId)
                    .eq("fair_id", fairId)
            );
        }));
    }

    // Keep every fair owned by this account aligned with the global code catalog.
    async function syncGlobalPriceCodesToAllFairs() {
        if (role !== "owner") return;

        const ownerFairs = fairs.filter(item => item.role === "owner");
        for (const item of ownerFairs) {
            await syncGlobalPriceCodesToFair(item.id);
        }
    }

    async function loadOwnerSection(page, force = false) {
        if (role !== "owner" || !fair || !page) return;
        const currentFairId = fair.id;
        const key = currentFairId + ":" + page;
        if (!force && ownerSectionLoadPromises.has(key)) {
            return ownerSectionLoadPromises.get(key);
        }

        const task = (async () => {
            switch (page) {
                case "dashboard":
                    // The dashboard needs summary totals only. Keep paginated
                    // sales/expense history queries for the Finance section.
                    await report({ includeDetails: false });
                    break;
                case "finance":
                    await report();
                    break;
                case "sales-activity":
                    await loadDailySalesCommission();
                    break;
                case "employee-sales":
                    await loadEmployeeSalesSheets(currentFairId);
                    break;
                case "fair-sales":
                    await loadSalesBreakdowns(currentFairId);
                    break;
                case "total-sales":
                    await loadTotalSalesOverview();
                    break;
                case "products":
                    await Promise.all([loadGlobalInventory(), loadProducts()]);
                    break;
                case "employees":
                    await loadCorrectionRequests();
                    break;
                case "personal":
                    await loadSalesBreakdowns(currentFairId);
                    break;
                case "settings":
                    break;
            }
            if (!fair || fair.id !== currentFairId) return;
        })();

        ownerSectionLoadPromises.set(key, task);
        try {
            await task;
        } catch (error) {
            ownerSectionLoadPromises.delete(key);
            throw error;
        }
    }


    async function chooseFair(id) {
        if (channel) {
            await db.removeChannel(channel);
            channel = null;
        }

        fair = fairs.find((f) => f.id === id) || null;
        role = fair?.role || null;
        finance = null;
        salesPage = 0;
        expensesPage = 0;
        selectedEmployeeSheetId = null;
        products = [];
        ownerSectionLoadPromises.clear();

        if (fair && user) {
            const snapshot = await getSnapshot(user.id) || {
                userId: user.id, fairs, productsByFair: {}
            };
            snapshot.fairs = fairs;
            snapshot.selectedFairId = fair.id;
            snapshot.productsByFair = snapshot.productsByFair || {};
            await saveSnapshot(snapshot);
        }

        toggle();

        if (!fair) {
            $("fairSalesBreakdown").innerHTML = '<p class="muted">Please select a fair to view its sales breakdown.</p>';
            return;
        }

        if (role === "employee") {
            await loadProducts();
            await Promise.all([
                refreshEmployeeItemsSold(),
                loadMyRecentSales().catch(error => {
                    console.warn("Could not load employee recent sales:", error);
                    $("myRecentSales").textContent = "Could not load recent sales. Tap Refresh to try again.";
                })
            ]);
        }

        if (role === "owner") {
            // Do not load every report and inventory table during login.
            // Each owner section fetches only its own data when opened.
            subscribe();
        }
    }

    // ========================================
    // 5. PRODUCTS & BUYING PRICES
    // ========================================

    async function refreshEmployeeItemsSold() {
        if (role !== "employee" || !fair || !user) return;

        let syncedItems = 0;
        let hasFreshServerCount = false;

        if (navigator.onLine) {
            try {
                syncedItems = Number(await data(
                    db.rpc("fair_sales_my_items_sold", { p_fair_id: fair.id })
                )) || 0;
                hasFreshServerCount = true;

                const snapshot = await getSnapshot(user.id) || {
                    userId: user.id, fairs, productsByFair: {}
                };
                snapshot.employeeItemsSoldByFair = snapshot.employeeItemsSoldByFair || {};
                snapshot.employeeItemsSoldByFair[fair.id] = syncedItems;
                await saveSnapshot(snapshot);
            } catch (error) {
                console.warn("Could not refresh employee item count:", error);
            }
        }

        if (!hasFreshServerCount) {
            const snapshot = await getSnapshot(user.id);
            syncedItems = Number(snapshot?.employeeItemsSoldByFair?.[fair.id]) || 0;
        }

        const pending = await getPendingSales();
        const pendingItems = pending
            .filter(item => item.entered_by === user.id && item.fair_id === fair.id)
            .reduce((sum, item) => sum + (Number(item.quantity) || 0), 0);

        const count = $("employeeItemsTotal");
        if (count) count.textContent = syncedItems + pendingItems;
    }

    async function loadMyRecentSales() {
        const container = $("myRecentSales");
        if (!container || role !== "employee" || !fair) return;
        if (!navigator.onLine) {
            container.innerHTML = '<p class="muted">Connect to the internet to load recent synced sales.</p>';
            return;
        }
        const rows = await data(db.rpc("fair_sales_get_my_recent_sales", { p_fair_id: fair.id }));
        container.innerHTML = rows.length ? rows.map(row => {
            const status = row.correction_status === "pending" ? "Correction pending"
                : row.correction_status === "approved" ? "Last correction approved"
                : row.correction_status === "rejected" ? "Last correction rejected"
                : "No correction requested";
            const canRequest = row.correction_status !== "pending";
            return `<div class="expense-row">
                <span class="expense-details">
                    <b>${esc(row.product_code)} · ${row.quantity} pcs</b><br>
                    <small>${esc(new Date(row.created_at).toLocaleString())} · ${money(row.unit_selling_price)} each</small><br>
                    <small>${esc(status)}</small>
                </span>
                <span class="expense-actions">
                    <b>${money(Number(row.quantity) * Number(row.unit_selling_price))}</b>
                    ${canRequest ? `<button type="button" class="secondary" data-request-correction="${esc(row.sale_id)}">Request correction</button>` : ""}
                </span>
            </div>`;
        }).join("") : '<p class="muted">No synced sales yet.</p>';
    }

    async function requestSaleCorrection(saleId) {
        if (role !== "employee" || !fair || !navigator.onLine) {
            msg("Connect to the internet before requesting a correction.", true);
            return;
        }
        const recent = await data(db.rpc("fair_sales_get_my_recent_sales", { p_fair_id: fair.id }));
        const sale = recent.find(item => item.sale_id === saleId);
        if (!sale) throw new Error("Sale not found in your recent sales.");
        const codeList = products.filter(p => p.active).map(p => p.product_code).join(", ");
        const productCode = window.prompt("Correct product code? Available: " + codeList, sale.product_code);
        if (productCode === null) return;
        const selected = products.find(p => p.active && p.product_code.toLowerCase() === productCode.trim().toLowerCase());
        if (!selected) throw new Error("That product code is not available in this fair.");
        const quantityText = window.prompt("Correct quantity:", String(sale.quantity));
        if (quantityText === null) return;
        const quantity = Number(quantityText);
        if (!Number.isInteger(quantity) || quantity < 1) throw new Error("Quantity must be a whole number of at least 1.");
        const priceText = window.prompt("Correct per-piece selling price (৳):", String(sale.unit_selling_price));
        if (priceText === null) return;
        const price = Number(priceText);
        if (!Number.isFinite(price) || price < 0) throw new Error("Enter a valid non-negative selling price.");
        const reason = window.prompt("Why does this sale need correction? (3–500 characters)");
        if (reason === null) return;
        if (reason.trim().length < 3 || reason.trim().length > 500) throw new Error("Please enter a reason between 3 and 500 characters.");
        await data(db.rpc("fair_sales_request_sale_correction", {
            p_sale_id: saleId,
            p_product_id: selected.id,
            p_quantity: quantity,
            p_unit_selling_price: price,
            p_reason: reason.trim()
        }));
        msg("Correction request sent to the owner.");
        await loadMyRecentSales();
    }

    async function loadCorrectionRequests() {
        const container = $("correctionRequests");
        if (!container || role !== "owner" || !fair) return;
        const rows = await data(db.rpc("fair_sales_get_correction_requests", { p_fair_id: fair.id }));
        container.innerHTML = rows.length ? rows.map(row => `
            <div class="expense-row">
                <span class="expense-details">
                    <b>${esc(row.requested_by_email || "Employee")} · ${esc(row.original_product_code)} → ${esc(row.requested_product_code)}</b><br>
                    <small>Before: ${row.original_quantity} pcs × ${money(row.original_unit_selling_price)}</small><br>
                    <small>Requested: ${row.requested_quantity} pcs × ${money(row.requested_unit_selling_price)}</small><br>
                    <small>Reason: ${esc(row.reason)}</small><br>
                    <small>${esc(new Date(row.created_at).toLocaleString())}</small>
                </span>
                <span class="expense-actions">
                    <button type="button" class="secondary" data-correction-decision="approve" data-request-id="${esc(row.request_id)}">Approve</button>
                    <button type="button" class="expense-delete" data-correction-decision="reject" data-request-id="${esc(row.request_id)}">Reject</button>
                </span>
            </div>
        `).join("") : '<p class="muted">No pending correction requests.</p>';
    }

    async function decideCorrection(requestId, approve) {
        if (role !== "owner" || !fair) throw new Error("Only the owner can decide correction requests.");
        const question = approve
            ? "Approve this correction? The saved sale and fair totals will be updated."
            : "Reject this correction? The original sale will remain unchanged.";
        if (!window.confirm(question)) return;
        await data(db.rpc("fair_sales_decide_sale_correction", {
            p_request_id: requestId,
            p_approve: approve
        }));
        msg(approve ? "Correction approved and sale updated." : "Correction rejected.");
        await Promise.all([report(), loadCorrectionRequests()]);
    }

    $("myRecentSales")?.addEventListener("click", event => {
        const button = event.target.closest("[data-request-correction]");
        if (!button) return;
        safe(() => requestSaleCorrection(button.dataset.requestCorrection));
    });

    $("refreshMySales")?.addEventListener("click", () => safe(loadMyRecentSales));
    $("correctionRequests")?.addEventListener("click", event => {
        const button = event.target.closest("[data-correction-decision]");
        if (!button) return;
        safe(() => decideCorrection(
            button.dataset.requestId,
            button.dataset.correctionDecision === "approve"
        ));
    });

    async function loadProducts() {
        try {
            products = await data(
                db.from("fair_sales_products")
                    .select("id,fair_id,product_code,active,default_selling_price,display_name")
                    .eq("fair_id", fair.id)
                    .eq("active", true)
                    .order("product_code")
            );
            const snapshot = await getSnapshot(user.id) || {
                userId: user.id, fairs, productsByFair: {}
            };
            snapshot.productsByFair = snapshot.productsByFair || {};
            snapshot.productsByFair[fair.id] = products.map(({id,fair_id,product_code,active,default_selling_price,display_name}) => ({
                id, fair_id, product_code, active, default_selling_price, display_name
            }));
            snapshot.selectedFairId = fair.id;
            snapshot.fairs = fairs;
            await saveSnapshot(snapshot);
        } catch (networkError) {
            if (!isNetworkError(networkError) && navigator.onLine) throw networkError;
            const snapshot = await getSnapshot(user.id);
            const cached = snapshot?.productsByFair?.[fair.id];
            if (!cached?.length) throw networkError;
            products = cached;
            msg("Offline mode: using saved product categories.");
        }

        if (role === "owner") {
            const costs = await data(
                db
                    .from("fair_sales_product_costs")
                    .select("product_id,buying_price")
                    .eq("fair_id", fair.id)
            );

            const m = new Map(
                costs.map((x) => [
                    x.product_id,
                    Number(x.buying_price)
                ])
            );

            products = products.map((p) => ({
                ...p,
                buying_price: m.get(p.id)
            }));

            $("productList").innerHTML = products
                .map(
                    (p) => `
                        <div class="product-row">
                            <span>
                                <b>${esc(p.product_code)}${p.display_name ? " — " + esc(p.display_name) : ""}</b><br>
                                <small>Buying: ${p.buying_price === undefined ? "Not set" : money(p.buying_price)}</small>
                            </span>
                            <span>
                                <b>Default selling: ${p.default_selling_price === null || p.default_selling_price === undefined ? "Not set" : money(p.default_selling_price)}</b><br>
                                <button type="button" class="quiet product-name-edit" data-product-code="${esc(p.product_code)}" data-display-name="${esc(p.display_name || "")}">Edit name</button>
                                <button type="button" class="quiet product-code-edit" data-product-code="${esc(p.product_code)}" data-display-name="${esc(p.display_name || "")}">Edit code / name</button>
                                <button type="button" class="quiet product-default-price-edit" data-product-code="${esc(p.product_code)}" data-default-price="${p.default_selling_price ?? ""}">Edit default price</button>
                            </span>
                        </div>
                    `
                )
                .join("") ||
                '<p class="muted">No categories yet. Add Product 1 and its cost.</p>';
        }

        $("productSelect").innerHTML =
            '<option value="">Choose product</option>' +
            products
                .map(
                    (p) =>
                        `<option value="${p.id}">${esc(p.product_code)}${p.display_name ? " — " + esc(p.display_name) : ""} — Fixed: ${p.default_selling_price === null || p.default_selling_price === undefined ? "Not set" : money(p.default_selling_price)}</option>`
                )
                .join("");
    }



    // ========================================
    // GLOBAL PURCHASES, STOCK & PERSONAL SALES
    // ========================================

    function fillGlobalProductSelect(id) {
        const select = $(id);
        if (!select) return;
        select.innerHTML = '<option value="">Choose product code</option>' +
            globalCatalog.map(item =>
                `<option value="${esc(item.product_code)}">${esc(item.product_code)}${item.display_name ? " — " + esc(item.display_name) : ""} — Buy ${money(item.buying_price)}</option>`
            ).join("");
    }

    function updatePurchasePreview() {
        const item = globalCatalog.find(x => x.product_code === $("purchaseCode").value);
        $("purchaseUnitCost").value = item ? money(item.buying_price) : "";
        $("purchaseTotal").textContent = money(
            (item ? Number(item.buying_price) : 0) * Math.max(0, Number($("purchaseQty").value) || 0)
        );
    }

    function updatePersonalPreview() {
        const item = globalCatalog.find(x => x.product_code === $("personalCode").value);
        const qty = Math.max(0, Number($("personalQty").value) || 0);
        const price = Math.max(0, Number($("personalPrice").value) || 0);
        const cost = item ? Number(item.buying_price) : 0;
        const revenue = qty * price;
        const profit = revenue - qty * cost;
        $("personalUnitCost").value = item ? money(cost) : "";
        $("personalRevenue").textContent = money(revenue);
        $("personalProfit").textContent = money(profit);
        $("personalMargin").textContent = revenue > 0 ? (profit / revenue * 100).toFixed(1) + "%" : "0%";
    }

    function renderGlobalInventory() {
        const rows = globalInventory || [];
        const totalStockValue = rows.reduce((sum, row) => sum + Number(row.stock_value || 0), 0);
        const totalAvailable = rows.reduce((sum, row) => sum + Number(row.available_quantity || 0), 0);
        const totalPurchased = rows.reduce((sum, row) => sum + Number(row.purchased_quantity || 0), 0);
        $("stockSummary").innerHTML = `
            <div class="report">
                <div>Available stock<b>${totalAvailable} pcs</b></div>
                <div>Current stock value<b>${money(totalStockValue)}</b></div>
                <div>Total purchase spend<b>${money(globalPurchaseTotal)}</b></div>
                <div>Purchased items<b>${totalPurchased} pcs</b></div>
            </div>
        `;

        $("inventoryList").innerHTML = rows.length ? `
            <div style="overflow:auto">
                <table class="sales-table">
                    <thead><tr><th>Code</th><th>Buy price</th><th>Purchased</th><th>Adjustment</th><th>Available</th><th>Stock value</th></tr></thead>
                    <tbody>${rows.map(row => `<tr>
                        <td><b>${esc(row.product_code)}</b></td>
                        <td>${money(row.buying_price)}</td>
                        <td>${row.purchased_quantity}</td>
                        <td>${row.adjusted_quantity}</td>
                        <td><b>${row.available_quantity}</b></td>
                        <td>${money(row.stock_value)}</td>
                    </tr>`).join("")}</tbody>
                </table>
            </div>
        ` : '<p class="muted">No global product codes found. Add a product code first.</p>';

        $("personalSalesSummary").innerHTML = `
            <div class="report">
                <div>Total personal items sold<b>${totalPersonalItems} pcs</b></div>
                <div>Total personal revenue<b>${money(totalPersonalRevenue)}</b></div>
                <div>Total product cost<b>${money(totalPersonalCost)}</b></div>
                <div>Full personal gross profit<b>${money(totalPersonalProfit)}</b></div>
                <div>Overall profit margin<b>${totalPersonalRevenue > 0 ? (totalPersonalProfit / totalPersonalRevenue * 100).toFixed(1) : "0.0"}%</b></div>
            </div>
        `;


        $("stockAdjustmentHistory").innerHTML = stockAdjustmentRows.length ? stockAdjustmentRows.map(row => `
            <div class="product-row stock-adjustment-row">
                <span>
                    <b>${esc(row.product_code)} · ${Number(row.quantity_delta) > 0 ? "+" : ""}${Number(row.quantity_delta)} pcs</b><br>
                    <small>${esc(day(row.adjustment_date))} · ${esc(row.reason)}</small>
                </span>
                <span class="inventory-actions">
                    <button type="button" class="quiet inventory-edit" data-stock-adjustment-action="edit" data-id="${esc(row.id)}">Edit</button>
                    <button type="button" class="danger inventory-delete" data-stock-adjustment-action="delete" data-id="${esc(row.id)}">Delete</button>
                </span>
            </div>`).join("") : '<p class="muted">No stock adjustments recorded yet.</p>';

        $("purchaseHistory").innerHTML = purchaseHistoryRows.length ? purchaseHistoryRows.map(row => `
            <div class="product-row">
                <span><b>${esc(row.product_code)}</b><br><small>${esc(day(row.purchase_date))} · ${row.quantity} pcs × ${money(row.unit_buying_price)}</small>${row.note ? `<br><small>${esc(row.note)}</small>` : ""}</span>
                <b>${money(Number(row.quantity) * Number(row.unit_buying_price))}</b>
            </div>`).join("") : '<p class="muted">No purchase entries yet.</p>';

        $("personalHistory").innerHTML = personalHistoryRows.length ? personalHistoryRows.map(row => {
            const revenue = Number(row.quantity) * Number(row.unit_selling_price);
            const cost = Number(row.quantity) * Number(row.unit_buying_price);
            const profit = revenue - cost;
            const margin = revenue > 0 ? (profit / revenue * 100).toFixed(1) : "0.0";
            return `<div class="product-row">
                <span><b>${esc(row.product_code)}</b><br><small>${esc(day(row.sale_date))} · ${row.quantity} pcs · Sell ${money(row.unit_selling_price)} / Buy ${money(row.unit_buying_price)}</small>${row.note ? `<br><small>${esc(row.note)}</small>` : ""}</span>
                <span><b>${money(profit)} profit</b><br><small>${margin}% margin</small></span>
            </div>`;
        }).join("") : '<p class="muted">No personal sales yet.</p>';
    }

    let purchaseHistoryRows = [];
    let personalHistoryRows = [];

    async function fetchAllRows(buildQuery, pageSize = 500) {
        const all = [];
        for (let from = 0; ; from += pageSize) {
            const batch = await data(buildQuery().range(from, from + pageSize - 1));
            all.push(...(batch || []));
            if (!batch || batch.length < pageSize) break;
        }
        return all;
    }

    async function loadSalesBreakdowns(selectedFairId = fair?.id) {
        const ownerFairs = fairs.filter(item => item.role === "owner");
        const selectedFair = ownerFairs.find(item => item.id === selectedFairId);
        if (!selectedFair) {
            $("fairSalesBreakdown").innerHTML = '<p class="muted">Please select a fair to view its sales breakdown.</p>';
        }
        const fairReports = selectedFair ? await Promise.all([selectedFair].map(async item => {
            const [entries, fairProducts, costs] = await Promise.all([
                fetchAllRows(() => db.from("fair_sales_entries")
                    .select("product_id,quantity,unit_selling_price")
                    .eq("fair_id", item.id)
                    .order("created_at", { ascending: true })),
                data(db.from("fair_sales_products").select("id,product_code").eq("fair_id", item.id)),
                data(db.from("fair_sales_product_costs").select("product_id,buying_price").eq("fair_id", item.id))
            ]);
            const codeById = new Map(fairProducts.map(p => [p.id, p.product_code]));
            const costById = new Map(costs.map(c => [c.product_id, Number(c.buying_price)]));
            const grouped = new Map();
            for (const sale of entries) {
                const code = codeById.get(sale.product_id) || "Unknown";
                const row = grouped.get(code) || { code, quantity: 0, revenue: 0, cost: 0, missing: 0 };
                const qty = Number(sale.quantity || 0);
                row.quantity += qty;
                row.revenue += qty * Number(sale.unit_selling_price || 0);
                if (costById.has(sale.product_id)) row.cost += qty * costById.get(sale.product_id);
                else row.missing += qty;
                grouped.set(code, row);
            }
            return { fair: item, rows: [...grouped.values()].sort((x,y) => x.code.localeCompare(y.code)) };
        })) : [];

        const personalEntries = await fetchAllRows(() => db.from("fair_sales_personal_entries")
            .select("product_code,quantity,unit_buying_price,unit_selling_price")
            .order("sale_date", { ascending: true }));
        const personalGrouped = new Map();
        for (const sale of personalEntries) {
            const code = sale.product_code || "Unknown";
            const row = personalGrouped.get(code) || { code, quantity: 0, revenue: 0, cost: 0 };
            const qty = Number(sale.quantity || 0);
            row.quantity += qty;
            row.revenue += qty * Number(sale.unit_selling_price || 0);
            row.cost += qty * Number(sale.unit_buying_price || 0);
            personalGrouped.set(code, row);
        }

        $("fairSalesBreakdown").innerHTML = fairReports.length ? fairReports.map(report => {
            const quantity = report.rows.reduce((sum,row) => sum + row.quantity, 0);
            const revenue = report.rows.reduce((sum,row) => sum + row.revenue, 0);
            const cost = report.rows.reduce((sum,row) => sum + row.cost, 0);
            const missing = report.rows.reduce((sum,row) => sum + row.missing, 0);
            const profit = revenue - cost;
            return `<div class="breakdown-card">
                <h3>${esc(report.fair.name)}</h3>
                <div class="report">
                    <div>Items sold<b>${quantity} pcs</b></div>
                    <div>Revenue<b>${money(revenue)}</b></div>
                    <div>Product cost<b>${missing ? "Incomplete" : money(cost)}</b></div>
                    <div>Gross profit<b>${missing ? "Incomplete" : money(profit)}</b></div>
                </div>
                <div style="overflow:auto"><table class="sales-table">
                    <thead><tr><th>Code</th><th>Qty sold</th><th>Revenue</th><th>Product cost</th><th>Gross profit</th></tr></thead>
                    <tbody>${report.rows.length ? report.rows.map(row => `<tr>
                        <td><b>${esc(row.code)}</b></td><td>${row.quantity}</td><td>${money(row.revenue)}</td>
                        <td>${row.missing ? "Missing" : money(row.cost)}</td>
                        <td>${row.missing ? "—" : money(row.revenue-row.cost)}</td>
                    </tr>`).join("") : '<tr><td colspan="5">No sales recorded for this fair.</td></tr>'}</tbody>
                </table></div>
                ${missing ? `<p class="muted">Warning: buying cost is missing for ${missing} sold item(s); profit is not shown as complete.</p>` : ""}
            </div>`;
        }).join("") : '<p class="muted">No fairs found.</p>';

        const personalRows = [...personalGrouped.values()].sort((x,y) => x.code.localeCompare(y.code));
        const pQty = personalRows.reduce((sum,row) => sum + row.quantity, 0);
        const pRevenue = personalRows.reduce((sum,row) => sum + row.revenue, 0);
        const pCost = personalRows.reduce((sum,row) => sum + row.cost, 0);
        $("personalBreakdownChart").innerHTML = `
            <div class="report">
                <div>Items sold<b>${pQty} pcs</b></div><div>Revenue<b>${money(pRevenue)}</b></div>
                <div>Product cost<b>${money(pCost)}</b></div><div>Gross profit<b>${money(pRevenue-pCost)}</b></div>
                <div>Profit margin<b>${pRevenue > 0 ? ((pRevenue-pCost)/pRevenue*100).toFixed(1) : "0.0"}%</b></div>
            </div>
            <div style="overflow:auto"><table class="sales-table">
                <thead><tr><th>Code</th><th>Qty sold</th><th>Revenue</th><th>Product cost</th><th>Gross profit</th><th>Margin</th></tr></thead>
                <tbody>${personalRows.length ? personalRows.map(row => {
                    const profit = row.revenue-row.cost;
                    return `<tr><td><b>${esc(row.code)}</b></td><td>${row.quantity}</td><td>${money(row.revenue)}</td>
                        <td>${money(row.cost)}</td><td>${money(profit)}</td>
                        <td>${row.revenue > 0 ? (profit/row.revenue*100).toFixed(1) : "0.0"}%</td></tr>`;
                }).join("") : '<tr><td colspan="6">No personal sales recorded yet.</td></tr>'}</tbody>
            </table></div>`;
    }

    async function loadTotalSalesOverview() {
        if (role !== "owner" || !user) return;

        const ownerFairs = fairs.filter(item => item.role === "owner");
        const fairTotals = await Promise.all(ownerFairs.map(async item => {
            const [entries, fairProducts, costs] = await Promise.all([
                fetchAllRows(() => db.from("fair_sales_entries")
                    .select("product_id,quantity,unit_selling_price")
                    .eq("fair_id", item.id)),
                data(db.from("fair_sales_products")
                    .select("id").eq("fair_id", item.id)),
                data(db.from("fair_sales_product_costs")
                    .select("product_id,buying_price").eq("fair_id", item.id))
            ]);
            const costById = new Map(costs.map(row => [row.product_id, Number(row.buying_price)]));
            let items = 0, revenue = 0, cost = 0, missing = 0;
            for (const sale of entries) {
                const qty = Number(sale.quantity || 0);
                items += qty;
                revenue += qty * Number(sale.unit_selling_price || 0);
                if (costById.has(sale.product_id)) cost += qty * costById.get(sale.product_id);
                else missing += qty;
            }
            return { items, revenue, cost, missing };
        }));

        const personalEntries = await fetchAllRows(() => db.from("fair_sales_personal_entries")
            .select("quantity,unit_buying_price,unit_selling_price"));
        let personalItems = 0, personalRevenue = 0, personalCost = 0;
        for (const sale of personalEntries) {
            const qty = Number(sale.quantity || 0);
            personalItems += qty;
            personalRevenue += qty * Number(sale.unit_selling_price || 0);
            personalCost += qty * Number(sale.unit_buying_price || 0);
        }

        const fairItems = fairTotals.reduce((sum, row) => sum + row.items, 0);
        const fairRevenue = fairTotals.reduce((sum, row) => sum + row.revenue, 0);
        const fairCost = fairTotals.reduce((sum, row) => sum + row.cost, 0);
        const missingFairCostItems = fairTotals.reduce((sum, row) => sum + row.missing, 0);
        const fairProfit = fairRevenue - fairCost;
        const personalProfit = personalRevenue - personalCost;
        const combinedRevenue = fairRevenue + personalRevenue;
        const combinedItems = fairItems + personalItems;
        const combinedProfit = missingFairCostItems ? null : fairProfit + personalProfit;

        $("totalSalesOverview").innerHTML = `
            <div class="report">
                <div>Total items sold<b>${combinedItems} pcs</b></div>
                <div>Combined sales revenue<b>${money(combinedRevenue)}</b></div>
                <div>Fair sales revenue<b>${money(fairRevenue)}</b></div>
                <div>Personal sales revenue<b>${money(personalRevenue)}</b></div>
                <div>Fair product cost<b>${missingFairCostItems ? "Incomplete" : money(fairCost)}</b></div>
                <div>Personal product cost<b>${money(personalCost)}</b></div>
                <div>Fair gross profit<b>${missingFairCostItems ? "Incomplete" : money(fairProfit)}</b></div>
                <div>Personal gross profit<b>${money(personalProfit)}</b></div>
                <div>Combined gross profit<b>${combinedProfit === null ? "Incomplete" : money(combinedProfit)}</b></div>
            </div>
            <p class="muted">Includes ${ownerFairs.length} owned fair(s) and all personal sales. Employee commission and fair expenses are not deducted from gross profit.</p>
            ${missingFairCostItems ? `<p class="muted">Profit is incomplete because buying cost is missing for ${missingFairCostItems} fair-sale item(s).</p>` : ""}
        `;
    }

    async function loadGlobalInventory() {
        if (role !== "owner") return;

        // Load the catalog first so dropdowns are not blocked by an unrelated report error.
        const [catalogRows, catalogNames] = await Promise.all([
            data(db.rpc("fair_sales_get_global_product_codes")),
            data(db.from("fair_sales_price_codes").select("product_code,display_name"))
        ]);
        const nameMap = new Map(catalogNames.map(item => [item.product_code, item.display_name]));
        globalCatalog = (catalogRows || []).map(item => ({
            ...item,
            display_name: nameMap.get(item.product_code) || null
        }));

        fillGlobalProductSelect("purchaseCode");
        fillGlobalProductSelect("personalCode");
        fillGlobalProductSelect("adjustCode");
        updatePurchasePreview();
        updatePersonalPreview();

        const results = await Promise.allSettled([
            data(db.rpc("fair_sales_get_global_inventory")),
            data(db.from("fair_sales_product_purchases")
                .select("id,product_code,quantity,unit_buying_price,purchase_date,note")
                .order("purchase_date", { ascending: false }).limit(50)),
            data(db.from("fair_sales_personal_entries")
                .select("id,product_code,quantity,unit_buying_price,unit_selling_price,sale_date,note")
                .order("sale_date", { ascending: false }).limit(50)),
            data(db.rpc("fair_sales_get_global_purchase_total")),
            data(db.from("fair_sales_stock_adjustments")
                .select("id,product_code,quantity_delta,adjustment_date,reason")
                .order("adjustment_date", { ascending: false })
                .order("created_at", { ascending: false }).limit(100))
        ]);

        const today = new Date().toISOString().slice(0, 10);
        if (!$("purchaseDate").value) $("purchaseDate").value = today;
        if (!$("personalDate").value) $("personalDate").value = today;
        if (!$("adjustDate").value) $("adjustDate").value = today;

        if (results[0].status === "fulfilled") globalInventory = results[0].value || [];
        else console.error("Global inventory could not load:", results[0].reason);
        if (results[1].status === "fulfilled") purchaseHistoryRows = results[1].value || [];
        else console.error("Purchase history could not load:", results[1].reason);
        if (results[2].status === "fulfilled") personalHistoryRows = results[2].value || [];
        else console.error("Personal sales history could not load:", results[2].reason);
        if (results[3].status === "fulfilled") globalPurchaseTotal = Number(results[3].value || 0);
        else console.error("Purchase total could not load:", results[3].reason);
        if (results[4].status === "fulfilled") stockAdjustmentRows = results[4].value || [];
        else console.error("Stock adjustment history could not load:", results[4].reason);

        renderGlobalInventory();
        updatePurchasePreview();
        updatePersonalPreview();

        if (results.some(result => result.status === "rejected")) {
            msg("Product codes loaded, but some stock summaries could not refresh. Please retry.", true);
        }
    }

    $("purchaseCode").addEventListener("change", updatePurchasePreview);
    $("purchaseQty").addEventListener("input", updatePurchasePreview);
    $("personalCode").addEventListener("change", updatePersonalPreview);
    $("personalQty").addEventListener("input", updatePersonalPreview);
    $("personalPrice").addEventListener("input", updatePersonalPreview);

    $("purchaseform").onsubmit = async (e) => {
        e.preventDefault();
        const button = e.submitter;
        if (role !== "owner" || !user) return msg("Only the owner can record purchases.", true);
        const code = $("purchaseCode").value;
        const item = globalCatalog.find(x => x.product_code === code);
        const quantity = Number($("purchaseQty").value);
        if (!item || !Number.isInteger(quantity) || quantity < 1) return msg("Choose a product and enter a valid quantity.", true);
        if (button) button.disabled = true;
        try {
            await data(db.from("fair_sales_product_purchases").insert({
                product_code: code,
                quantity,
                unit_buying_price: Number(item.buying_price),
                purchase_date: $("purchaseDate").value,
                note: $("purchaseNote").value.trim() || null,
                created_by: user.id
            }));
            e.target.reset();
            $("purchaseDate").value = new Date().toISOString().slice(0, 10);
            await loadGlobalInventory();
            msg("Purchase saved. Global stock increased.");
        } catch (error) {
            msg(error.message || "Could not save purchase.", true);
        } finally {
            if (button) button.disabled = false;
        }
    };

    $("personalform").onsubmit = async (e) => {
        e.preventDefault();
        const button = e.submitter;
        if (role !== "owner" || !user) return msg("Only the owner can add personal sales.", true);
        const code = $("personalCode").value;
        const item = globalCatalog.find(x => x.product_code === code);
        const quantity = Number($("personalQty").value);
        const selling = Number($("personalPrice").value);
        const available = Number(globalInventory.find(x => x.product_code === code)?.available_quantity || 0);
        if (!item || !Number.isInteger(quantity) || quantity < 1 || !Number.isFinite(selling) || selling < 0 || $("personalPrice").value === "") {
            return msg("Choose a product and enter valid quantity and selling price.", true);
        }
        if (quantity > available) return msg("Not enough stock. Available: " + available + " pcs.", true);
        if (button) button.disabled = true;
        try {
            await data(db.from("fair_sales_personal_entries").insert({
                product_code: code,
                quantity,
                unit_buying_price: Number(item.buying_price),
                unit_selling_price: selling,
                sale_date: $("personalDate").value,
                note: $("personalNote").value.trim() || null,
                created_by: user.id
            }));
            e.target.reset();
            $("personalDate").value = new Date().toISOString().slice(0, 10);
            await loadGlobalInventory();
            msg("Personal sale saved. Stock and profit updated.");
        } catch (error) {
            msg(error.message || "Could not save personal sale.", true);
        } finally {
            if (button) button.disabled = false;
        }
    };


    function closeStockAdjustmentDialog() {
        const dialog = $("stockAdjustmentEditDialog");
        if (dialog?.open) dialog.close();
        editingStockAdjustmentId = null;
    }

    $("cancelStockAdjustmentEdit").addEventListener("click", closeStockAdjustmentDialog);

    $("stockAdjustmentEditForm").addEventListener("submit", async (e) => {
        e.preventDefault();
        if (role !== "owner" || !user || !editingStockAdjustmentId) return;
        const row = stockAdjustmentRows.find(item => item.id === editingStockAdjustmentId);
        if (!row) return msg("This stock adjustment could not be found. Refresh inventory.", true);

        const delta = Number($("editAdjustmentDelta").value);
        const reason = $("editAdjustmentReason").value.trim();
        const date = $("editAdjustmentDate").value;
        if (!Number.isInteger(delta) || delta === 0 || !reason || !date) {
            return msg("Enter a non-zero whole-number quantity, date and reason.", true);
        }

        const currentAvailable = Number(globalInventory.find(item => item.product_code === row.product_code)?.available_quantity || 0);
        const nextAvailable = currentAvailable - Number(row.quantity_delta) + delta;
        if (nextAvailable < 0) return msg("This change would make available stock negative.", true);

        const button = $("saveStockAdjustmentEdit");
        button.disabled = true;
        try {
            await data(db.from("fair_sales_stock_adjustments")
                .update({ quantity_delta: delta, adjustment_date: date, reason })
                .eq("id", editingStockAdjustmentId)
                .eq("created_by", user.id));
            closeStockAdjustmentDialog();
            await loadGlobalInventory();
            msg("Stock adjustment updated. Available stock recalculated.");
        } catch (error) {
            msg(error.message || "Could not update stock adjustment.", true);
        } finally {
            button.disabled = false;
        }
    });

    $("stockAdjustmentHistory").addEventListener("click", async (e) => {
        const button = e.target.closest("[data-stock-adjustment-action]");
        if (!button || role !== "owner" || !user) return;
        const row = stockAdjustmentRows.find(item => item.id === button.dataset.id);
        if (!row) return msg("Stock adjustment not found. Refresh inventory.", true);

        if (button.dataset.stockAdjustmentAction === "edit") {
            editingStockAdjustmentId = row.id;
            $("editAdjustmentDelta").value = row.quantity_delta;
            $("editAdjustmentDate").value = day(row.adjustment_date);
            $("editAdjustmentReason").value = row.reason;
            $("stockAdjustmentEditDialog").showModal();
            return;
        }

        if (button.dataset.stockAdjustmentAction === "delete") {
            if (!window.confirm("Delete this stock adjustment permanently? Available stock will be recalculated. This will not change purchase records.")) return;
            button.disabled = true;
            try {
                await data(db.from("fair_sales_stock_adjustments")
                    .delete()
                    .eq("id", row.id)
                    .eq("created_by", user.id));
                await loadGlobalInventory();
                msg("Stock adjustment deleted. Available stock recalculated.");
            } catch (error) {
                msg(error.message || "Could not delete stock adjustment.", true);
                button.disabled = false;
            }
        }
    });

    $("adjustform").onsubmit = async (e) => {
        e.preventDefault();
        const button = e.submitter;
        if (role !== "owner" || !user) return msg("Only the owner can adjust stock.", true);
        const code = $("adjustCode").value;
        const delta = Number($("adjustDelta").value);
        const reason = $("adjustReason").value.trim();
        if (!globalCatalog.some(x => x.product_code === code) || !Number.isInteger(delta) || delta === 0 || !reason) {
            return msg("Choose a product, enter a non-zero quantity change and reason.", true);
        }
        const available = Number(globalInventory.find(x => x.product_code === code)?.available_quantity || 0);
        if (available + delta < 0) return msg("Adjustment would make stock negative.", true);
        if (button) button.disabled = true;
        try {
            await data(db.from("fair_sales_stock_adjustments").insert({
                product_code: code,
                quantity_delta: delta,
                adjustment_date: $("adjustDate").value,
                reason,
                created_by: user.id
            }));
            e.target.reset();
            $("adjustDate").value = new Date().toISOString().slice(0, 10);
            await loadGlobalInventory();
            msg("Stock adjustment saved.");
        } catch (error) {
            msg(error.message || "Could not adjust stock.", true);
        } finally {
            if (button) button.disabled = false;
        }
    };


    // ========================================
    // 6. OWNER REPORT & PROFIT CALCULATION
    // ========================================

    async function report({ includeDetails = true } = {}) {
        if (role !== "owner" || !fair) return;

        const currentFairId = fair.id;
        const salesFrom = salesPage * REPORT_PAGE_SIZE;
        const expensesFrom = expensesPage * REPORT_PAGE_SIZE;

        const [totals, ssResult, cc, eeResult, ff] = await Promise.all([
            data(db.rpc("fair_sales_get_report_totals", { p_fair_id: currentFairId })),
            includeDetails
                ? db.from("fair_sales_entries").select("*", { count: "exact" })
                    .eq("fair_id", currentFairId)
                    .order("created_at", { ascending: false })
                    .range(salesFrom, salesFrom + REPORT_PAGE_SIZE - 1)
                : Promise.resolve({ data: [], count: 0, error: null }),
            includeDetails
                ? data(db.from("fair_sales_product_costs").select("product_id,buying_price").eq("fair_id", currentFairId))
                : Promise.resolve([]),
            includeDetails
                ? db.from("fair_sales_expenses").select("*", { count: "exact" })
                    .eq("fair_id", currentFairId)
                    .order("expense_date", { ascending: false })
                    .range(expensesFrom, expensesFrom + REPORT_PAGE_SIZE - 1)
                : Promise.resolve({ data: [], count: 0, error: null }),
            data(db.from("fair_sales_financials").select("*").eq("fair_id", currentFairId).single())
        ]);

        if (ssResult.error) throw ssResult.error;
        if (eeResult.error) throw eeResult.error;
        if (!fair || fair.id !== currentFairId) return;

        const totalSalesCount = ssResult.count || 0;
        const totalExpenseCount = eeResult.count || 0;
        const totalSalesPages = Math.max(1, Math.ceil(totalSalesCount / REPORT_PAGE_SIZE));
        const totalExpensePages = Math.max(1, Math.ceil(totalExpenseCount / REPORT_PAGE_SIZE));

        if (includeDetails && salesPage >= totalSalesPages && salesPage > 0) {
            salesPage = totalSalesPages - 1;
            return report();
        }
        if (includeDetails && expensesPage >= totalExpensePages && expensesPage > 0) {
            expensesPage = totalExpensePages - 1;
            return report();
        }

        const ss = ssResult.data || [];
        const ee = eeResult.data || [];
        sales = ss;
        expenses = ee;
        finance = ff;

        const cost = new Map(cc.map(c => [c.product_id, Number(c.buying_price)]));
        const pm = new Map(products.map(p => [p.id, p]));
        const revenue = Number(totals.revenue || 0);
        const cogs = Number(totals.cogs || 0);
        const items = Number(totals.items || 0);
        const commission = revenue * Number(finance.commission_rate || 0);
        const days = Math.max(1, Math.round((
            new Date(fair.end_date + "T00:00:00") -
            new Date(fair.start_date + "T00:00:00")
        ) / 86400000) + 1);
        // Combine the fair's preset other-expense amount with all recorded
        // expense entries. Normalize RPC output so missing/null values display 0,
        // never an empty report line.
        // Normalize every financial input before arithmetic. A missing or
        // malformed value must show as ৳0, never as a blank/NaN report value.
        const amount = (value) => {
            const parsed = Number(value ?? 0);
            return Number.isFinite(parsed) ? parsed : 0;
        };
        const reportExpenseTotal = amount(totals?.expense_total);
        const presetOtherExpenses = amount(finance?.other_expenses);
        const otherAdditional = reportExpenseTotal + presetOtherExpenses;
        const lunch = days * amount(finance?.lunch_per_day);
        const stallRent = amount(finance?.stall_rent);
        const safeCommission = amount(commission);
        const safeCogs = amount(cogs);
        const safeRevenue = amount(revenue);
        const totalExpense = otherAdditional + lunch + safeCommission;
        const investmentSubtotal = safeCogs + stallRent;
        const fairInvestment = totalExpense + investmentSubtotal;
        const profit = safeRevenue - fairInvestment;

        $("salesTotal").textContent = money(safeRevenue);
        $("profitTotal").textContent = money(profit);
        $("itemsTotal").textContent = items;
        $("commissionTotal").textContent = money(safeCommission);
        $("costTotal").textContent = money(safeCogs);
        $("rentTotal").textContent = money(stallRent);
        $("lunchTotal").textContent = money(lunch);
        $("fairReportCommission").textContent = money(commission);
        $("otherAdditionalTotal").textContent = money(otherAdditional);
        $("expenseTotal").textContent = money(totalExpense);
        $("investmentSubtotal").textContent = money(investmentSubtotal);
        $("fairInvestmentTotal").textContent = money(fairInvestment);

        const missingCosts = Number(totals.missing_cost_count || 0);
        $("salesList").innerHTML = ss.length ? `
            <div style="overflow:auto">
                <table class="sales-table">
                    <thead><tr>
                        <th>Time</th><th>Product</th><th>Qty</th><th>Default price</th>
                        <th>Actual price</th><th>Sales</th><th>Cost</th><th>Margin</th>
                    </tr></thead>
                    <tbody>${ss.map(s => {
                        const p = pm.get(s.product_id);
                        const sale = Number(s.quantity) * Number(s.unit_selling_price);
                        const defaultPrice = s.default_unit_selling_price;
                        const unitCost = cost.get(s.product_id);
                        const rowCost = unitCost === undefined ? null : Number(s.quantity) * unitCost;
                        return `<tr>
                            <td>${esc(new Date(s.created_at).toLocaleString())}</td>
                            <td>${esc(p?.product_code || "Product")}</td>
                            <td>${s.quantity}</td>
                            <td>${defaultPrice === null || defaultPrice === undefined ? "—" : money(defaultPrice)}</td>
                            <td>${money(s.unit_selling_price)}</td>
                            <td>${money(sale)}</td>
                            <td>${rowCost === null ? "Missing" : money(rowCost)}</td>
                            <td>${rowCost === null ? "—" : money(sale - rowCost)}</td>
                        </tr>`;
                    }).join("")}</tbody>
                </table>
            </div>
            <div class="report-pager">
                <span>Showing ${salesFrom + 1}–${Math.min(salesFrom + ss.length, totalSalesCount)} of ${totalSalesCount} sales</span>
                <div>
                    <button type="button" class="quiet" data-sales-page="-1" ${salesPage === 0 ? "disabled" : ""}>Previous</button>
                    <span>Page ${salesPage + 1} of ${totalSalesPages}</span>
                    <button type="button" class="quiet" data-sales-page="1" ${salesPage + 1 >= totalSalesPages ? "disabled" : ""}>Next</button>
                </div>
            </div>
            ${missingCosts ? `<p class="muted">${missingCosts} sale(s) have no recorded buying cost; profit may be overstated.</p>` : ""}
        ` : '<p class="muted">No sales recorded yet.</p>';

        renderExpenses();
        $("expensePager").innerHTML = totalExpenseCount ? `
            <span>Showing ${expensesFrom + 1}–${Math.min(expensesFrom + ee.length, totalExpenseCount)} of ${totalExpenseCount} expenses</span>
            <div>
                <button type="button" class="quiet" data-expenses-page="-1" ${expensesPage === 0 ? "disabled" : ""}>Previous</button>
                <span>Page ${expensesPage + 1} of ${totalExpensePages}</span>
                <button type="button" class="quiet" data-expenses-page="1" ${expensesPage + 1 >= totalExpensePages ? "disabled" : ""}>Next</button>
            </div>
        ` : "";
    }


    // Each employee gets an independent sheet within the selected fair.
    // Membership IDs identify the employee; sales are filtered by entered_by.
    async function loadEmployeeSalesSheets(currentFairId = fair?.id) {
        if (role !== "owner" || !currentFairId || !fair || fair.id !== currentFairId) return;

        const tabs = $("employeeSalesTabs");
        const sheet = $("salesList");
        if (!tabs || !sheet) return;

        tabs.innerHTML = '<span class="muted">Loading employees...</span>';
        sheet.innerHTML = '<p class="muted">Loading employee sales...</p>';

        try {
            const members = await data(
                db.from("fair_sales_memberships")
                    .select("user_id,created_at")
                    .eq("fair_id", currentFairId)
                    .eq("role", "employee")
                    .order("created_at", { ascending: true })
            );

            if (!fair || fair.id !== currentFairId) return;

            const employees = members || [];
            if (!employees.length) {
                selectedEmployeeSheetId = null;
                tabs.innerHTML = "";
                sheet.innerHTML = '<p class="muted">No employees are assigned to this fair yet.</p>';
                return;
            }

            if (!employees.some(item => item.user_id === selectedEmployeeSheetId)) {
                selectedEmployeeSheetId = employees[0].user_id;
            }

            tabs.innerHTML = employees.map((employee, index) => {
                const active = employee.user_id === selectedEmployeeSheetId;
                return `<button type="button" class="employee-sheet-tab${active ? " active" : ""}"
                    role="tab" aria-selected="${active}" data-employee-sheet-id="${esc(employee.user_id)}">
                    Employee ${index + 1}
                </button>`;
            }).join("");

            await renderEmployeeSalesSheet(selectedEmployeeSheetId, employees);
        } catch (error) {
            console.error("Employee sales sheets could not load:", error);
            tabs.innerHTML = "";
            sheet.innerHTML = '<p class="muted">Could not load employee sheets. Use Refresh to try again.</p>';
        }
    }

    async function renderEmployeeSalesSheet(employeeId, employees = null) {
        if (role !== "owner" || !fair || !employeeId) return;
        const currentFairId = fair.id;
        const sheet = $("salesList");
        if (!sheet) return;

        selectedEmployeeSheetId = employeeId;
        if (employees) {
            $("employeeSalesTabs").querySelectorAll("[data-employee-sheet-id]").forEach(button => {
                const active = button.dataset.employeeSheetId === employeeId;
                button.classList.toggle("active", active);
                button.setAttribute("aria-selected", String(active));
            });
        }

        sheet.innerHTML = '<p class="muted">Loading this employee\'s sales...</p>';
        try {
            const [entries, costs, fairFinance] = await Promise.all([
                fetchAllRows(() => db.from("fair_sales_entries")
                    .select("*")
                    .eq("fair_id", currentFairId)
                    .eq("entered_by", employeeId)
                    .order("created_at", { ascending: false })),
                data(db.from("fair_sales_product_costs")
                    .select("product_id,buying_price")
                    .eq("fair_id", currentFairId)),
                data(db.from("fair_sales_financials")
                    .select("commission_rate")
                    .eq("fair_id", currentFairId)
                    .single())
            ]);

            if (!fair || fair.id !== currentFairId || selectedEmployeeSheetId !== employeeId) return;

            const costMap = new Map((costs || []).map(item => [item.product_id, Number(item.buying_price)]));
            const productMap = new Map(products.map(item => [item.id, item]));
            const totalItems = entries.reduce((sum, item) => sum + Number(item.quantity || 0), 0);
            const totalSales = entries.reduce((sum, item) => sum + Number(item.quantity || 0) * Number(item.unit_selling_price || 0), 0);
            const totalCost = entries.reduce((sum, item) => {
                const unitCost = costMap.get(item.product_id);
                return sum + (unitCost === undefined ? 0 : Number(item.quantity || 0) * unitCost);
            }, 0);
            const missingCosts = entries.filter(item => !costMap.has(item.product_id)).length;
            const commissionRate = Number(fairFinance?.commission_rate ?? 0.10);
            const commissionLabel = Number((commissionRate * 100).toFixed(2)) + "%";
            const totalCommission = totalSales * commissionRate;

            sheet.innerHTML = `
                <div class="report employee-sheet-summary">
                    <div>Total items<b>${totalItems}</b></div>
                    <div>Total sales<b>${money(totalSales)}</b></div>
                    <div>Commission (${commissionLabel})<b>${money(totalCommission)}</b></div>
                    <div>Gross profit<b>${money(totalSales - totalCost)}</b></div>
                </div>
                ${entries.length ? `
                    <div style="overflow:auto">
                        <table class="sales-table">
                            <thead><tr><th>Time</th><th>Product</th><th>Qty</th><th>Price / pc</th><th>Sales</th><th>Commission (${commissionLabel})</th><th>Cost</th><th>Gross profit</th></tr></thead>
                            <tbody>${entries.map(item => {
                                const product = productMap.get(item.product_id);
                                const sale = Number(item.quantity) * Number(item.unit_selling_price);
                                const unitCost = costMap.get(item.product_id);
                                const rowCost = unitCost === undefined ? null : Number(item.quantity) * unitCost;
                                return `<tr>
                                    <td>${esc(new Date(item.created_at).toLocaleString())}</td>
                                    <td>${esc(product?.product_code || "Product")}</td>
                                    <td>${item.quantity}</td>
                                    <td>${money(item.unit_selling_price)}</td>
                                    <td>${money(sale)}</td>
                                    <td>${money(sale * commissionRate)}</td>
                                    <td>${rowCost === null ? "Missing" : money(rowCost)}</td>
                                    <td>${rowCost === null ? "—" : money(sale - rowCost)}</td>
                                </tr>`;
                            }).join("")}</tbody>
                        </table>
                    </div>
                    ${missingCosts ? `<p class="muted">${missingCosts} sale(s) have no recorded buying cost; gross profit may be understated.</p>` : ""}
                ` : '<p class="muted">No sales recorded by this employee for the selected fair yet.</p>'}
            `;
        } catch (error) {
            console.error("Employee sales sheet failed:", error);
            if (fair?.id === currentFairId && selectedEmployeeSheetId === employeeId) {
                sheet.innerHTML = '<p class="muted">Could not load this employee\'s sales. Use Refresh to try again.</p>';
            }
        }
    }

    const employeeSalesTabs = $("employeeSalesTabs");
    if (employeeSalesTabs) {
        employeeSalesTabs.addEventListener("click", event => {
            const button = event.target.closest("[data-employee-sheet-id]");
            if (!button) return;
            const employeeId = button.dataset.employeeSheetId;
            employeeSalesTabs.querySelectorAll("[data-employee-sheet-id]").forEach(tab => {
                const active = tab === button;
                tab.classList.toggle("active", active);
                tab.setAttribute("aria-selected", String(active));
            });
            renderEmployeeSalesSheet(employeeId);
        });
    }

    // Owner-only daily sales and employee-wise commission report.
    // Commission remains 10% of each employee's own recorded daily sales.
    async function loadDailySalesCommission() {
        if (role !== "owner" || !fair) return;
        const reportBox = $("dailySalesCommission");
        if (!reportBox) return;
        const currentFairId = fair.id;
        reportBox.innerHTML = '<p class="muted">Loading daily sales...</p>';

        try {
            const [entries, members, fairFinance] = await Promise.all([
                fetchAllRows(() => db.from("fair_sales_entries")
                    .select("created_at,quantity,unit_selling_price,entered_by")
                    .eq("fair_id", currentFairId)
                    .order("created_at", { ascending: true })),
                data(db.from("fair_sales_memberships")
                    .select("user_id,created_at")
                    .eq("fair_id", currentFairId)
                    .eq("role", "employee")
                    .order("created_at", { ascending: true })),
                data(db.from("fair_sales_financials")
                    .select("commission_rate")
                    .eq("fair_id", currentFairId)
                    .single())
            ]);
            if (!fair || fair.id !== currentFairId) return;

            const employees = (members || []).map((member, index) => ({
                id: member.user_id,
                label: "Employee " + (index + 1)
            }));
            const employeeIds = new Set(employees.map(employee => employee.id));

            const dateKeyInDhaka = timestamp => {
                const parts = new Intl.DateTimeFormat("en-CA", {
                    timeZone: "Asia/Dhaka", year: "numeric", month: "2-digit", day: "2-digit"
                }).formatToParts(new Date(timestamp));
                const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
                return values.year + "-" + values.month + "-" + values.day;
            };

            const daily = new Map();
            for (const entry of entries) {
                const date = dateKeyInDhaka(entry.created_at);
                const row = daily.get(date) || { date, items: 0, sales: 0, employeeSales: {} };
                const quantity = Number(entry.quantity || 0);
                const saleAmount = quantity * Number(entry.unit_selling_price || 0);
                row.items += quantity;
                row.sales += saleAmount;
                if (employeeIds.has(entry.entered_by)) {
                    row.employeeSales[entry.entered_by] =
                        (row.employeeSales[entry.entered_by] || 0) + saleAmount;
                }
                daily.set(date, row);
            }

            // Include fair dates with zero sales so every fair day has its own row.
            const startDate = new Date(fair.start_date + "T00:00:00Z");
            const endDate = new Date(fair.end_date + "T00:00:00Z");
            for (let cursor = new Date(startDate); cursor <= endDate; cursor.setUTCDate(cursor.getUTCDate() + 1)) {
                const date = cursor.toISOString().slice(0, 10);
                if (!daily.has(date)) daily.set(date, { date, items: 0, sales: 0, employeeSales: {} });
            }

            const rows = [...daily.values()].sort((a, b) => a.date.localeCompare(b.date));
            const totalItems = rows.reduce((sum, row) => sum + row.items, 0);
            const totalSales = rows.reduce((sum, row) => sum + row.sales, 0);
            const commissionRate = Number(fairFinance?.commission_rate ?? 0.10);
            const commissionLabel = Number((commissionRate * 100).toFixed(2)) + "%";
            const totalCommission = totalSales * commissionRate;
            const employeeTotals = {};
            employees.forEach(employee => {
                employeeTotals[employee.id] = rows.reduce(
                    (sum, row) => sum + Number(row.employeeSales[employee.id] || 0), 0
                );
            });
            const dateLabel = value => new Date(value + "T12:00:00Z")
                .toLocaleDateString("en-GB", {
                    day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Dhaka"
                });

            const employeeHeaders = employees.map(employee =>
                "<th>" + esc(employee.label) + " sales</th><th>" +
                esc(employee.label) + " commission (" + commissionLabel + ")</th>"
            ).join("");
            const employeeTotalsHtml = employees.map(employee =>
                "<div>" + esc(employee.label) + " commission<b>" +
                money(employeeTotals[employee.id] * commissionRate) + "</b></div>"
            ).join("");

            reportBox.innerHTML =
                '<div class="report">' +
                    '<div>Total items sold<b>' + totalItems + ' pcs</b></div>' +
                    '<div>Total sales<b>' + money(totalSales) + '</b></div>' +
                    '<div>Total commission (' + commissionLabel + ')<b>' + money(totalCommission) + '</b></div>' +
                    employeeTotalsHtml +
                '</div>' +
                '<p class="muted">Each employee commission is calculated separately from their own recorded sales for that date.</p>' +
                '<div style="overflow:auto"><table class="sales-table">' +
                    '<thead><tr><th>Date</th><th>Total items sold</th><th>Total sales</th>' +
                    employeeHeaders + '<th>Total commission (' + commissionLabel + ')</th></tr></thead>' +
                    '<tbody>' + rows.map(row =>
                        '<tr><td>' + esc(dateLabel(row.date)) + '</td>' +
                        '<td>' + row.items + ' pcs</td><td>' + money(row.sales) + '</td>' +
                        employees.map(employee => {
                            const employeeSales = Number(row.employeeSales[employee.id] || 0);
                            return '<td>' + money(employeeSales) + '</td><td>' +
                                money(employeeSales * commissionRate) + '</td>';
                        }).join("") +
                        '<td>' + money(row.sales * commissionRate) + '</td></tr>'
                    ).join("") + '</tbody></table></div>';
        } catch (error) {
            console.error("Daily sales and commission report failed:", error);
            reportBox.innerHTML = '<p class="muted">Daily report could not load. Please use Refresh to try again.</p>';
        }
    }


    $("salesList").addEventListener("click", (event) => {
        const button = event.target.closest("[data-sales-page]");
        if (!button || button.disabled) return;
        salesPage = Math.max(0, salesPage + Number(button.dataset.salesPage));
        safe(report);
    });

    $("expensePager").addEventListener("click", (event) => {
        const button = event.target.closest("[data-expenses-page]");
        if (!button || button.disabled) return;
        expensesPage = Math.max(0, expensesPage + Number(button.dataset.expensesPage));
        safe(report);
    });

    function renderExpenses() {
        $("expenseList").innerHTML = expenses
            .map(
                (e) => `
                    <div class="expense-row">
                        <span class="expense-details">
                            <b>${esc(e.description)}</b><br>
                            <small>${esc(day(e.expense_date))}</small>
                        </span>
                        <span class="expense-actions">
                            <b>${money(e.amount)}</b>
                            <button
                                type="button"
                                class="expense-delete"
                                data-expense-id="${esc(e.id)}"
                                aria-label="Delete ${esc(e.description)} expense"
                            >Delete</button>
                        </span>
                    </div>
                `
            )
            .join("") ||
            '<p class="muted">No additional expenses yet.</p>';
    }

    $("expenseList").addEventListener("click", async (event) => {
        const button = event.target.closest(".expense-delete");
        if (!button) return;

        if (role !== "owner" || !fair) {
            msg("Only the owner can delete expenses.", true);
            return;
        }

        const expenseId = button.dataset.expenseId;
        const selectedExpense = expenses.find((item) => item.id === expenseId);
        if (!selectedExpense) {
            msg("Expense not found. Refresh the report and try again.", true);
            return;
        }

        if (!window.confirm(`Delete "${selectedExpense.description}" expense (${money(selectedExpense.amount)})? This cannot be undone.`)) {
            return;
        }

        button.disabled = true;
        button.textContent = "Deleting...";

        try {
            await data(
                db.from("fair_sales_expenses")
                    .delete()
                    .eq("id", expenseId)
                    .eq("fair_id", fair.id)
            );

            await report();
            msg("Expense deleted.");
        } catch (error) {
            button.disabled = false;
            button.textContent = "Delete";
            msg(error.message || "Could not delete this expense.", true);
        }
    });


    // ========================================
    // 7. REAL-TIME SALES SYNC
    // ========================================

    let realtimeRefreshTimer = null;
    let realtimeRefreshRunning = false;

    function subscribe() {
        if (!fair) return;
        channel = db
            .channel("fair-sales-" + fair.id)
            .on(
                "postgres_changes",
                {
                    event: "*",
                    schema: "public",
                    table: "fair_sales_entries",
                    filter: "fair_id=eq." + fair.id
                },
                () => {
                    // A burst of employee sales can generate many realtime events.
                    // Debounce them and refresh only the section currently on screen.
                    if (realtimeRefreshTimer) clearTimeout(realtimeRefreshTimer);
                    realtimeRefreshTimer = setTimeout(() => {
                        realtimeRefreshTimer = null;
                        if (realtimeRefreshRunning || !fair || role !== "owner" || !activeOwnerPage) return;
                        realtimeRefreshRunning = true;
                        safe(async () => {
                            await loadOwnerSection(activeOwnerPage, true);
                        }).finally(() => {
                            realtimeRefreshRunning = false;
                        });
                    }, 450);
                }
            )
            .subscribe((status) => {
                $("sync").textContent =
                    status === "SUBSCRIBED"
                        ? "● Live sync"
                        : status === "CHANNEL_ERROR"
                            ? "● Sync issue"
                            : "● Connecting";
            });
    }


    // ========================================
    // 8. LOGIN & SIGNUP EVENTS
    // ========================================

    $("loginTab").onclick = () => setMode("login");
    $("signupTab").onclick = () => setMode("signup");

    $("authform").onsubmit = async (e) => {
        e.preventDefault();

        const b = $("authbtn");
        b.disabled = true;

        try {
            if (!db?.auth) await clientReadyPromise;
            if (!db?.auth) {
                throw new Error("Supabase client could not initialize. Reload the page and check the connection.");
            }

            const email = $("email").value.trim().toLowerCase();
            const password = $("password").value;

            if (mode === "signup") {
                const { data: d, error } =
                    await db.auth.signUp({ email, password });

                if (error) {
                    throw error;
                }

                if (!d.session) {
                    msg(
                        "Account created. Confirm your email, then sign in."
                    );

                    setMode("login");
                    return;
                }

                msg("Account created.");
            } else {
                const { error } =
                    await db.auth.signInWithPassword({
                        email,
                        password
                    });

                if (error) {
                    throw error;
                }
            }
        } catch (e) {
            msg(e.message, true);
        } finally {
            b.disabled = false;
            b.textContent =
                mode === "login" ? "Sign in" : "Create account";
        }
    };

    $("out").onclick = () => db.auth.signOut();

    $("fairSelect").onchange = (e) =>
        safe(() => chooseFair(e.target.value));


    // ========================================
    // 9. EMPLOYEE SALES FORM
    // ========================================

    const retrySyncButton = $("retrySync");
    if (retrySyncButton) {
        retrySyncButton.onclick = () => syncPendingSales();
    }

    const cleanupPendingButton = $("cleanupPending");
    if (cleanupPendingButton) {
        cleanupPendingButton.onclick = async () => {
            if (cleanupPendingButton.disabled) return;
            cleanupPendingButton.disabled = true;
            cleanupPendingButton.textContent = "Checking fairs...";
            try {
                // Refresh authoritative assignments and show the number of queued
                // sales that no longer belong to an assigned fair.
                await loadFairs();
                const staleCount = lastCleanedPendingCount;
                let removed = 0;
                if (staleCount) {
                    const confirmed = window.confirm(
                        staleCount + " pending sale(s) belong to a fair that is no longer assigned to this account. " +
                        "These sales may not have synced before access changed. Delete them permanently from this phone?"
                    );
                    if (confirmed) {
                        removed = await removePendingSalesForDeletedFairs(fairs.map(item => item.id));
                    }
                }
                await updatePendingStatus();
                if ($("entryStatus")) {
                    $("entryStatus").textContent = removed
                        ? removed + " old pending sale(s) deleted after your confirmation. Current-fair sales were kept."
                        : staleCount
                            ? "Old-fair pending sales were kept on this phone. Restore fair access or review them before deleting."
                            : "No pending sales from deleted/unassigned fairs found.";
                }
                msg(removed
                    ? removed + " old pending sale(s) deleted."
                    : staleCount
                        ? "Pending sales were kept; nothing was deleted."
                        : "No deleted-fair pending sales to clean.");
                await syncPendingSales();
            } catch (error) {
                console.error("Pending sale cleanup failed:", error);
                if ($("entryStatus")) {
                    $("entryStatus").textContent = "Cleanup could not finish: " + (error.message || String(error));
                }
                msg("Could not check fair assignments. Pending sales were not intentionally cleared.", true);
            } finally {
                cleanupPendingButton.disabled = false;
                cleanupPendingButton.textContent = "Clean deleted-fair sales";
            }
        };
    }

    $("saleform").onsubmit = async (e) => {
        e.preventDefault();

        try {
            if (role !== "employee" || !fair) {
                throw Error("No employee fair selected.");
            }

            const product_id = $("productSelect").value;
            const quantity = Number($("qty").value);
            const unit_selling_price = Number($("price").value);

            if (
                !product_id ||
                !Number.isInteger(quantity) ||
                quantity < 1 ||
                !Number.isFinite(unit_selling_price) ||
                unit_selling_price < 0
            ) {
                throw Error(
                    "Enter valid product, quantity and price."
                );
            }

            const selectedProduct = products.find((p) => p.id === product_id);
            const default_unit_selling_price =
                selectedProduct?.default_selling_price === null || selectedProduct?.default_selling_price === undefined
                    ? null
                    : Number(selectedProduct.default_selling_price);

            const saleRecord = {
                id: crypto.randomUUID(),
                fair_id: fair.id,
                product_id,
                quantity,
                default_unit_selling_price,
                unit_selling_price,
                entered_by: user.id,
                created_at: new Date().toISOString()
            };

            let queuedForSync = false;
            if (navigator.onLine) {
                try {
                    await data(
                        db.from("fair_sales_entries").insert(saleRecord)
                    );
                } catch (networkError) {
                    if (!isNetworkError(networkError)) {
                        throw networkError;
                    }
                    await savePendingSale(saleRecord);
                    queuedForSync = true;
                }
            } else {
                await savePendingSale(saleRecord);
                queuedForSync = true;
            }

            $("entryStatus").textContent =
                `Saved: ${
                    products.find((p) => p.id === product_id)?.product_code
                }, ${quantity} pcs at ${money(unit_selling_price)} each.`;

            $("qty").value = 1;
            $("price").value = "";
            $("employeeDefaultPrice").value = "";
            $("productSelect").value = "";
            $("total").textContent = money(0);

            await refreshEmployeeItemsSold();
            if (!queuedForSync) {
                try { await loadMyRecentSales(); } catch (recentError) {
                    console.warn("Recent sales refresh failed:", recentError);
                }
            }

            const pendingCount = await updatePendingStatus();
            msg(pendingCount
                ? "Sale saved on this device. Waiting to sync."
                : "Sale saved successfully.");

            // A failed fetch can happen even while navigator.onLine is true;
            // in that case no new "online" event is guaranteed to fire.
            if (queuedForSync && navigator.onLine) {
                setTimeout(() => syncPendingSales(), 2000);
            }
        } catch (e) {
            msg(e.message, true);
        }
    };

    const updateTotal = () => {
        $("total").textContent = money(
            Math.max(0, Number($("qty").value) || 0) *
            Math.max(0, Number($("price").value) || 0)
        );
    };

    $("qty").oninput = updateTotal;
    $("price").oninput = updateTotal;



    
    // ========================================
    // 10. MANAGE / DELETE FAIR
    // ========================================

    const manageFairSelect = $("manageFairSelect");
    const deleteFairBtn = $("deleteFairBtn");

    if (manageFairSelect && deleteFairBtn) {
        manageFairSelect.onchange = () => {
            deleteFairBtn.disabled =
                role !== "owner" || !manageFairSelect.value;
        };

        deleteFairBtn.onclick = async () => {
            const fairId = manageFairSelect.value;
            const selectedFair = fairs.find(
                (item) => item.id === fairId
            );

            if (role !== "owner" || !selectedFair || !fairId) {
                msg("Select a fair that you own.", true);
                return;
            }

            const confirmed = window.confirm(
                `Delete "${selectedFair.name}" permanently? All sales, products, expenses and fair records belonging to this fair will also be deleted. This cannot be undone.`
            );

            if (!confirmed) return;

            deleteFairBtn.disabled = true;
            deleteFairBtn.textContent = "Deleting...";

            try {
                await data(
                    db.rpc("fair_sales_delete_fair", {
                        p_fair_id: fairId
                    })
                );

                if (fair?.id === fairId) {
                    fair = null;
                    products = [];
                    sales = [];
                    expenses = [];
                    finance = null;

                    if (channel) {
                        await db.removeChannel(channel);
                        channel = null;
                    }
                }

                await loadFairs();
                msg("Fair deleted successfully.");

            } catch (e) {
                msg(
                    e.message || "Could not delete this fair.",
                    true
                );
            } finally {
                deleteFairBtn.textContent =
                    "Delete selected fair";

                deleteFairBtn.disabled =
                    role !== "owner" || !manageFairSelect.value;
            }
        };
    }



    // ========================================
    // 10. CREATE FAIR FORM
    // ========================================

    $("fairform").onsubmit = async (e) => {
        e.preventDefault();

        try {
            if (role !== "owner") {
                throw Error("Only the owner can create a fair.");
            }

            if ($("end").value < $("start").value) {
                throw Error(
                    "End date must be on or after start date."
                );
            }

            const f = await data(
    db.rpc("fair_sales_create_fair", {
        p_name: $("fairName").value.trim(),
        p_start_date: $("start").value,
        p_end_date: $("end").value,
        p_stall_rent: Number($("rent").value || 0),
        p_lunch_per_day: Number($("lunch").value || 0),
        p_commission_rate: Number($("commission").value || 0) / 100,
        p_other_expenses: Number($("other").value || 0)
    })
);

           

            e.target.reset();

            $("lunch").value = 100;
            $("commission").value = 10;

            await loadFairs();

            $("fairSelect").value = f.id;
            await syncGlobalPriceCodesToFair(f.id);
            await chooseFair(f.id);

            msg("Fair created. Now add product categories.");
        } catch (e) {
            msg(e.message, true);
        }
    };


    // Rename a global product code while preserving linked purchase, stock,
    // personal-sale and fair-sales history through database foreign-key cascades.
    $("productList").addEventListener("click", async (event) => {
        const nameButton = event.target.closest(".product-name-edit");
        if (nameButton) {
            if (role !== "owner" || !user) {
                msg("Only the owner can edit product names.", true);
                return;
            }
            const code = nameButton.dataset.productCode;
            const currentName = nameButton.dataset.displayName || "";
            const enteredName = window.prompt("Enter a display name for " + code + " (leave blank to clear):", currentName);
            if (enteredName === null) return;
            const displayName = enteredName.trim();
            if (displayName.length > 80) {
                msg("Product name must be 80 characters or fewer.", true);
                return;
            }
            nameButton.disabled = true;
            try {
                await data(db.rpc("fair_sales_update_product_name", {
                    p_product_code: code,
                    p_display_name: displayName
                }));
                await Promise.all([loadProducts(), loadGlobalInventory()]);
                msg("Product name updated for " + code + " across your fairs.");
            } catch (error) {
                msg(error.message || "Could not update product name.", true);
            } finally {
                nameButton.disabled = false;
            }
            return;
        }

        const priceButton = event.target.closest(".product-default-price-edit");
        if (priceButton) {
            if (role !== "owner" || !user) {
                msg("Only the owner can edit default prices.", true);
                return;
            }
            const code = priceButton.dataset.productCode;
            const currentPrice = priceButton.dataset.defaultPrice;
            const entered = window.prompt("Enter the new default selling price (zero or more):", currentPrice);
            if (entered === null) return;
            const normalized = entered.trim();
            const newPrice = Number(normalized);
            if (normalized === "" || !Number.isFinite(newPrice) || newPrice < 0) {
                msg("Enter a valid default selling price of zero or more.", true);
                return;
            }
            priceButton.disabled = true;
            try {
                await data(db.rpc("fair_sales_update_default_price", {
                    p_product_code: code,
                    p_default_selling_price: newPrice
                }));
                await Promise.all([loadProducts(), loadGlobalInventory()]);
                msg("Default selling price updated for " + code + " across your fairs.");
            } catch (error) {
                msg(error.message || "Could not update default selling price.", true);
            } finally {
                priceButton.disabled = false;
            }
            return;
        }

        const button = event.target.closest(".product-code-edit");
        if (!button) return;
        if (role !== "owner" || !user) {
            msg("Only the owner can edit product codes and names.", true);
            return;
        }

        $("editProductOldCode").value = button.dataset.productCode || "";
        $("editProductCode").value = button.dataset.productCode || "";
        $("editProductName").value = button.dataset.displayName || "";
        $("productEditDialog").showModal();
    });

    $("productEditForm").addEventListener("submit", async (event) => {
        event.preventDefault();
        if (role !== "owner" || !user) {
            msg("Only the owner can edit product codes and names.", true);
            return;
        }

        const oldCode = $("editProductOldCode").value;
        const newCode = $("editProductCode").value.trim().toUpperCase();
        const displayName = $("editProductName").value.trim();
        if (!/^[A-Z][0-9]$/.test(newCode)) {
            msg("Use one capital letter followed by one number, for example A7.", true);
            return;
        }
        if (displayName.length > 80) {
            msg("Product name must be 80 characters or fewer.", true);
            return;
        }

        const saveButton = $("saveProductEdit");
        saveButton.disabled = true;
        try {
            if (newCode !== oldCode) {
                await data(db.rpc("fair_sales_rename_price_code", {
                    p_old_product_code: oldCode,
                    p_new_product_code: newCode
                }));
            }
            await data(db.rpc("fair_sales_update_product_name", {
                p_product_code: newCode,
                p_display_name: displayName
            }));
            $("productEditDialog").close();
            await Promise.all([loadProducts(), loadGlobalInventory()]);
            msg("Product saved: " + newCode + (displayName ? " — " + displayName : "") + ".");
        } catch (error) {
            msg(error.message || "Could not update product code and name.", true);
        } finally {
            saveButton.disabled = false;
        }
    });

    // ========================================
    // 11. PRODUCT FORM
    // ========================================

    // Live per-piece profit estimate based on the owner's two entered prices.
    function updateExpectedProfit() {
        const buyingValue = $("buying").value;
        const sellingValue = $("defaultPrice").value;

        if (buyingValue === "" || sellingValue === "") {
            $("expectedProfit").value = "";
            return;
        }

        const profit = Number(sellingValue) - Number(buyingValue);
        $("expectedProfit").value = money(profit);
    }

    $("defaultPrice").addEventListener("input", updateExpectedProfit);

    $("productform").onsubmit = async (e) => {
        e.preventDefault();

        try {
            if (role !== "owner" || !fair) {
                throw Error("Choose a fair as owner.");
            }

            const productCode = $("code").value.trim().toUpperCase();
            const buyingPrice = Number($("buying").value);

            if (!/^[A-Z][0-9]$/.test(productCode)) {
                throw Error("Enter a code with one capital letter and one digit, for example A7.");
            }

            if (!Number.isFinite(buyingPrice) || buyingPrice < 0 || $("buying").value === "") {
                throw Error("Enter a valid buying price of zero or more.");
            }

            const displayName = $("displayName").value.trim();
            if (displayName.length > 80) {
                throw Error("Product name must be 80 characters or fewer.");
            }

            const sellingPrice = Number($("defaultPrice").value);
            if (!Number.isFinite(sellingPrice) || sellingPrice < 0 || $("defaultPrice").value === "") {
                throw Error("Enter a valid default selling price of zero or more.");
            }

            // Save the code and default selling price atomically in one database transaction.
            await data(
                db.rpc("fair_sales_save_price_code", {
                    p_fair_id: fair.id,
                    p_buying_price: buyingPrice,
                    p_product_code: productCode,
                    p_default_selling_price: sellingPrice
                })
            );

            // Propagate the saved global mapping to every other fair owned by this account.
            await data(db.rpc("fair_sales_update_product_name", {
                p_product_code: productCode,
                p_display_name: displayName
            }));
            await syncGlobalPriceCodesToAllFairs();

            e.target.reset();
            updateExpectedProfit();

            await loadProducts();

            msg("Global product code saved and synced across all your fairs.");
        } catch (e) {
            msg(e.message, true);
        }
    };


    // Prevent a slow catalog lookup from overwriting a new product's manually entered price.
    let priceLookupSequence = 0;

    $("buying").addEventListener("change", async () => {
        const rawPrice = $("buying").value;
        if (rawPrice === "" || role !== "owner") return;

        const lookupSequence = ++priceLookupSequence;
        const codeAtLookupStart = $("code").value;
        const defaultPriceAtLookupStart = $("defaultPrice").value;

        try {
            const matches = await data(
                db.from("fair_sales_price_codes")
                    .select("product_code,default_selling_price")
                    .eq("buying_price", Number(rawPrice))
                    .limit(1)
            );

            // Ignore results for an older buying price or a lookup superseded by typing.
            if (
                lookupSequence !== priceLookupSequence ||
                $("buying").value !== rawPrice
            ) return;

            if (matches.length) {
                if ($("code").value === codeAtLookupStart) {
                    $("code").value = matches[0].product_code;
                    $("code").readOnly = true;
                }
                // Do not replace a fixed price the owner has already started typing.
                if ($("defaultPrice").value === defaultPriceAtLookupStart) {
                    $("defaultPrice").value = matches[0].default_selling_price ?? "";
                }
                updateExpectedProfit();
                msg("Existing global code applied: " + matches[0].product_code);
            } else {
                $("code").readOnly = false;
                // Keep any manually entered fixed price for a new product code.
                updateExpectedProfit();
            }
        } catch (error) {
            console.warn("Could not check global price catalog:", error);
            if (lookupSequence === priceLookupSequence) {
                $("code").readOnly = false;
            }
        }
    });

    $("buying").addEventListener("input", () => {
        // Cancel any pending lookup as soon as the buying price is edited.
        priceLookupSequence += 1;
        if (!$("buying").value) {
            $("code").value = "";
            $("code").readOnly = false;
            $("defaultPrice").value = "";
        }
        updateExpectedProfit();
    });

    $("productSelect").addEventListener("change", () => {
        const selected = products.find((p) => p.id === $("productSelect").value);
        const defaultPrice = selected?.default_selling_price;
        $("employeeDefaultPrice").value =
            defaultPrice === null || defaultPrice === undefined ? "" : Number(defaultPrice);
        // Start actual price at the owner's default; employee can edit it after bargaining.
        $("price").value =
            defaultPrice === null || defaultPrice === undefined ? "" : Number(defaultPrice);
        updateTotal();
    });

    // ========================================
    // 12. ADD EMPLOYEE FORM
    // ========================================

    $("employeeform").onsubmit = async (e) => {
        e.preventDefault();

        try {
            if (role !== "owner" || !fair) {
                throw Error(
                    "Only the owner can add employees to a selected fair."
                );
            }

            await data(
                db.rpc("fair_sales_add_employee", {
                    p_fair_id: fair.id,
                    p_email: $("employeeEmail").value
                        .trim()
                        .toLowerCase()
                })
            );

            e.target.reset();

            msg("Employee added. Ask them to sign in.");
        } catch (e) {
            msg(e.message, true);
        }
    };


    // ========================================
    // 13. ADD EXPENSE FORM
    // ========================================

    $("expenseform").onsubmit = async (e) => {
        e.preventDefault();

        try {
            if (role !== "owner" || !fair) {
                throw Error(
                    "Only the owner can add expenses to a selected fair."
                );
            }

            await data(
                db
                    .from("fair_sales_expenses")
                    .insert({
                        fair_id: fair.id,
                        description: $("desc").value.trim(),
                        amount: +$("amount").value,
                        expense_date: $("expenseDate").value,
                        created_by: user.id
                    })
            );

            e.target.reset();

            $("expenseDate").value =
                new Date().toISOString().slice(0, 10);

            await report();

            msg("Expense saved.");
        } catch (e) {
            msg(e.message, true);
        }
    };


    // ========================================
    // 14. REFRESH REPORT
    // ========================================

    $("refresh").onclick = () => safe(async () => {
        if (role === "owner") {
            if (activeOwnerPage) await loadOwnerSection(activeOwnerPage, true);
        } else if (role === "employee") {
            await Promise.all([refreshEmployeeItemsSold(), loadMyRecentSales()]);
        }
    });


    // ========================================
    // 15. INITIALIZE APP & RESTORE SESSION
    // ========================================

    document.addEventListener("DOMContentLoaded", async () => {
        if (!cfg?.supabaseUrl || !cfg?.supabaseKey) {
            const error = new Error("Supabase configuration is missing. Please contact the app owner.");
            rejectClientReady(error);
            msg(error.message, true);
            return;
        }

        // Recover if the primary jsDelivr script was blocked or did not expose
        // the UMD global. The unpkg fallback avoids leaving db undefined.
        if (!window.supabase?.createClient) {
            try {
                await new Promise((resolve, reject) => {
                    const fallback = document.createElement("script");
                    fallback.src = "https://unpkg.com/@supabase/supabase-js@2";
                    fallback.async = true;
                    fallback.onload = () => window.supabase?.createClient
                        ? resolve()
                        : reject(new Error("Supabase library loaded without createClient."));
                    fallback.onerror = () => reject(new Error("Could not load Supabase from either CDN."));
                    document.head.appendChild(fallback);
                });
            } catch (libraryError) {
                console.error("Supabase library initialization failed:", libraryError);
                rejectClientReady(libraryError);
                msg("Supabase library could not load. Check your internet connection and reload.", true);
                return;
            }
        }

        S = window.supabase;
        if (typeof S?.createClient !== "function") {
            const error = new Error("Supabase library is unavailable. Please reload the page.");
            rejectClientReady(error);
            msg(error.message, true);
            return;
        }

        try {
            db = S.createClient(
            cfg.supabaseUrl,
            cfg.supabaseKey,
            {
                auth: {
                    persistSession: true,
                    autoRefreshToken: true
                }
            }
            );
            if (!db || !db.auth || typeof db.auth.onAuthStateChange !== "function") {
                throw new Error("Supabase client was not created correctly. Please reload the app.");
            }
            resolveClientReady(db);
        } catch (clientError) {
            console.error("Supabase client creation failed:", clientError);
            rejectClientReady(clientError);
            msg("Supabase client could not be created. Please reload the page.", true);
            return;
        }

        $("expenseDate").value =
            new Date().toISOString().slice(0, 10);

        window.addEventListener("online", () => {
            // Browsers may report online before the connection can reach Supabase.
            // Delay briefly, then retry; the background retry below covers transient failures.
            setTimeout(() => syncPendingSales(), 1500);
        });
        window.addEventListener("offline", () => {
            updatePendingStatus().catch(console.error);
        });
        window.addEventListener("focus", () => {
            if (navigator.onLine) syncPendingSales();
        });
        document.addEventListener("visibilitychange", () => {
            if (!document.hidden && navigator.onLine) syncPendingSales();
        });

        // Do not rely on a single "online" event. If it fired too early or was
        // missed while the app was open, retry pending sales every 15 seconds.
        if (syncRetryTimer) clearInterval(syncRetryTimer);
        syncRetryTimer = setInterval(async () => {
            if (!user || !navigator.onLine || syncingSales) return;
            try {
                const pending = await getPendingSales();
                if (pending.some(item => item.entered_by === user.id)) {
                    await syncPendingSales();
                }
            } catch (error) {
                console.warn("Background pending-sales check failed:", error);
            }
        }, 15000);

        db.auth.onAuthStateChange((_e, s) => {
            setTimeout(
                () => safe(() => startSession(s)),
                0
            );
        });

        db.auth
            .getSession()
            .then(({ data: d }) =>
                safe(() => startSession(d.session))
            )
            .catch((e) => msg(e.message, true));
    });
})();