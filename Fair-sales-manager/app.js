(() => {
    // ========================================
    // 1. DOM, CONFIGURATION & APP STATE
    // ========================================

    const $ = (id) => document.getElementById(id);

    const cfg = window.FAIR_APP_CONFIG;
    const S = window.supabase;

    let db;
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

    // After a successful online fair/membership refresh, discard this user's
    // queued sales only when their fair no longer exists in their assignments.
    // This cleans up local test data for deleted fairs without touching sales
    // belonging to any currently assigned fair.
    async function removePendingSalesForDeletedFairs(validFairIds) {
        if (!user || !navigator.onLine) return 0;

        const validIds = new Set(validFairIds);
        const pending = await getPendingSales();
        const stale = pending.filter(item =>
            item.entered_by === user.id && !validIds.has(item.fair_id)
        );

        for (const sale of stale) {
            await removePendingSale(sale.id);
        }

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
            const mine = pending.filter(item => item.entered_by === user.id);
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
            const remoteFairs = await data(
                db.from("fair_sales_fairs").select("*").order("created_at", { ascending: false })
            );
            const ms = await data(
                db.from("fair_sales_memberships").select("fair_id,role").eq("user_id", user.id)
            );
            const roles = new Map(ms.map((m) => [m.fair_id, m.role]));
            fairs = remoteFairs.filter((f) => roles.has(f.id)).map((f) => ({
                ...f,
                role: roles.get(f.id)
            }));
            // Only purge stale local queue items after a successful online
            // refresh from the server, never from an offline cached snapshot.
            lastCleanedPendingCount = await removePendingSalesForDeletedFairs(fairs.map(item => item.id));
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
                .select("product_code,buying_price,default_selling_price")
                .order("product_code")
        );

        for (const item of catalog) {
            const productId = await data(
                db.rpc("fair_sales_add_price_code", {
                    p_fair_id: fairId,
                    p_buying_price: Number(item.buying_price),
                    p_product_code: item.product_code
                })
            );
            if (item.default_selling_price !== null && item.default_selling_price !== undefined) {
                await data(
                    db.from("fair_sales_products")
                        .update({ default_selling_price: Number(item.default_selling_price) })
                        .eq("id", productId)
                        .eq("fair_id", fairId)
                );
            }
        }
    }

    // Keep every fair owned by this account aligned with the global code catalog.
    async function syncGlobalPriceCodesToAllFairs() {
        if (role !== "owner") return;

        const ownerFairs = fairs.filter(item => item.role === "owner");
        for (const item of ownerFairs) {
            await syncGlobalPriceCodesToFair(item.id);
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
        products = [];

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
            return;
        }

        if (role === "owner") {
            finance = await data(
                db
                    .from("fair_sales_financials")
                    .select("*")
                    .eq("fair_id", fair.id)
                    .single()
            );

            await syncGlobalPriceCodesToFair(fair.id);
        }

        await loadProducts();

        if (role === "employee") {
            await refreshEmployeeItemsSold();
        }

        if (role === "owner") {
            await report();
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

    async function loadProducts() {
        try {
            products = await data(
                db.from("fair_sales_products")
                    .select("id,fair_id,product_code,active,default_selling_price")
                    .eq("fair_id", fair.id)
                    .eq("active", true)
                    .order("product_code")
            );
            const snapshot = await getSnapshot(user.id) || {
                userId: user.id, fairs, productsByFair: {}
            };
            snapshot.productsByFair = snapshot.productsByFair || {};
            snapshot.productsByFair[fair.id] = products.map(({id,fair_id,product_code,active,default_selling_price}) => ({
                id, fair_id, product_code, active, default_selling_price
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
                                <b>${esc(p.product_code)}</b><br>
                                <small>Buying: ${p.buying_price === undefined ? "Not set" : money(p.buying_price)}</small>
                            </span>
                            <b>Default selling: ${p.default_selling_price === null || p.default_selling_price === undefined ? "Not set" : money(p.default_selling_price)}</b>
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
                        `<option value="${p.id}">${esc(p.product_code)}</option>`
                )
                .join("");
    }


    // ========================================
    // 6. OWNER REPORT & PROFIT CALCULATION
    // ========================================

    async function report() {
        if (role !== "owner" || !fair) {
            return;
        }

        const [ss, cc, ee, ff] = await Promise.all([
            data(
                db
                    .from("fair_sales_entries")
                    .select("*")
                    .eq("fair_id", fair.id)
                    .order("created_at", { ascending: false })
            ),

            data(
                db
                    .from("fair_sales_product_costs")
                    .select("product_id,buying_price")
                    .eq("fair_id", fair.id)
            ),

            data(
                db
                    .from("fair_sales_expenses")
                    .select("*")
                    .eq("fair_id", fair.id)
                    .order("expense_date", { ascending: false })
            ),

            data(
                db
                    .from("fair_sales_financials")
                    .select("*")
                    .eq("fair_id", fair.id)
                    .single()
            )
        ]);

        sales = ss;
        expenses = ee;
        finance = ff;

        const cost = new Map(
            cc.map((c) => [
                c.product_id,
                Number(c.buying_price)
            ])
        );

        const pm = new Map(
            products.map((p) => [p.id, p])
        );

        let revenue = 0;
        let cogs = 0;
        let items = 0;

        for (const s of ss) {
            revenue +=
                Number(s.quantity) *
                Number(s.unit_selling_price);

            cogs +=
                Number(s.quantity) *
                (cost.get(s.product_id) || 0);

            items += Number(s.quantity);
        }

        const commission =
            revenue * Number(finance.commission_rate || 0);

        const days = Math.max(
            1,
            Math.round(
                (
                    new Date(fair.end_date + "T00:00:00") -
                    new Date(fair.start_date + "T00:00:00")
                ) / 86400000
            ) + 1
        );

        const other =
            Number(finance.other_expenses || 0) +
            ee.reduce((a, x) => a + Number(x.amount), 0);

        const lunch =
            days * Number(finance.lunch_per_day || 0);

        const profit =
            revenue -
            cogs -
            commission -
            Number(finance.stall_rent || 0) -
            lunch -
            other;

        $("salesTotal").textContent = money(revenue);
        $("profitTotal").textContent = money(profit);
        $("itemsTotal").textContent = items;
        $("commissionTotal").textContent = money(commission);
        $("costTotal").textContent = money(cogs);
        $("rentTotal").textContent = money(finance.stall_rent);
        $("lunchTotal").textContent = money(lunch);
        $("expenseTotal").textContent = money(other);

        $("salesList").innerHTML = ss.length
            ? `
                <div style="overflow:auto">
                    <table class="sales-table">
                        <thead>
                            <tr>
                                <th>Time</th>
                                <th>Product</th>
                                <th>Qty</th>
                                <th>Default price</th>
                                <th>Actual price</th>
                                <th>Sales</th>
                                <th>Cost</th>
                                <th>Margin</th>
                            </tr>
                        </thead>

                        <tbody>
                            ${ss
                                .map((s) => {
                                    const p = pm.get(s.product_id);

                                    const sale =
                                        Number(s.quantity) *
                                        Number(s.unit_selling_price);
                                    const defaultPrice = s.default_unit_selling_price;

                                    const c =
                                        Number(s.quantity) *
                                        (cost.get(s.product_id) || 0);

                                    return `
                                        <tr>
                                            <td>${esc(new Date(s.created_at).toLocaleString())}</td>
                                            <td>${esc(p?.product_code || "Product")}</td>
                                            <td>${s.quantity}</td>
                                            <td>${defaultPrice === null || defaultPrice === undefined ? "—" : money(defaultPrice)}</td>
                                            <td>${money(s.unit_selling_price)}</td>
                                            <td>${money(sale)}</td>
                                            <td>${money(c)}</td>
                                            <td>${money(sale - c)}</td>
                                        </tr>
                                    `;
                                })
                                .join("")}
                        </tbody>
                    </table>
                </div>
            `
            : '<p class="muted">No sales recorded yet.</p>';

        renderExpenses();
    }

    function renderExpenses() {
        $("expenseList").innerHTML = expenses
            .map(
                (e) => `
                    <div class="expense-row">
                        <span>
                            <b>${esc(e.description)}</b><br>
                            <small>${esc(day(e.expense_date))}</small>
                        </span>
                        <b>${money(e.amount)}</b>
                    </div>
                `
            )
            .join("") ||
            '<p class="muted">No additional expenses yet.</p>';
    }


    // ========================================
    // 7. REAL-TIME SALES SYNC
    // ========================================

    function subscribe() {
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
                () => safe(report)
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
                // Refresh authoritative online fair assignments, then remove
                // only queued sales whose fair is no longer assigned to user.
                await loadFairs();
                const removed = lastCleanedPendingCount;
                await updatePendingStatus();
                if ($("entryStatus")) {
                    $("entryStatus").textContent = removed
                        ? removed + " pending sale(s) from deleted/unassigned fairs removed. Current-fair sales were kept."
                        : "No pending sales from deleted/unassigned fairs found. Current-fair sales were kept.";
                }
                msg(removed
                    ? removed + " old pending sale(s) cleaned up."
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
            $("productSelect").value = "";
            $("defaultPriceHint").textContent = "Choose a product to see its default selling price.";
            $("total").textContent = money(0);

            await refreshEmployeeItemsSold();

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

            await chooseFair(f.id);

            msg("Fair created. Now add product categories.");
        } catch (e) {
            msg(e.message, true);
        }
    };


    // ========================================
    // 11. PRODUCT FORM
    // ========================================

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

            const sellingPrice = Number($("defaultSelling").value);
            if (!Number.isFinite(sellingPrice) || sellingPrice < 0 || $("defaultSelling").value === "") {
                throw Error("Enter a valid default selling price of zero or more.");
            }

            await data(
                db.rpc("fair_sales_add_price_code", {
                    p_fair_id: fair.id,
                    p_buying_price: buyingPrice,
                    p_product_code: productCode
                })
            );

            await data(
                db.rpc("fair_sales_set_price_code_selling_price", {
                    p_product_code: productCode,
                    p_selling_price: sellingPrice
                })
            );

            // Propagate the new global price/code mapping to all existing fairs.
            await syncGlobalPriceCodesToAllFairs();

            e.target.reset();

            await loadProducts();

            msg("Global product code saved and synced across all your fairs.");
        } catch (e) {
            msg(e.message, true);
        }
    };


    $("buying").addEventListener("change", async () => {
        const rawPrice = $("buying").value;
        if (rawPrice === "" || role !== "owner") return;

        try {
            const matches = await data(
                db.from("fair_sales_price_codes")
                    .select("product_code,default_selling_price")
                    .eq("buying_price", Number(rawPrice))
                    .limit(1)
            );
            if (matches.length) {
                $("code").value = matches[0].product_code;
                $("code").readOnly = true;
                $("defaultSelling").value = matches[0].default_selling_price ?? "";
                msg("Existing global code applied: " + matches[0].product_code);
            } else {
                $("code").readOnly = false;
            }
        } catch (error) {
            console.warn("Could not check global price catalog:", error);
            $("code").readOnly = false;
        }
    });

    $("buying").addEventListener("input", () => {
        if (!$("buying").value) {
            $("code").value = "";
            $("code").readOnly = false;
            $("defaultSelling").value = "";
        }
    });

    $("productSelect").addEventListener("change", () => {
        const selected = products.find((p) => p.id === $("productSelect").value);
        $("price").value = selected?.default_selling_price ?? "";
        $("defaultPriceHint").textContent =
            selected?.default_selling_price === null || selected?.default_selling_price === undefined
                ? "Default selling price not set yet. Ask the owner to set it."
                : "Default selling price: " + money(selected.default_selling_price) + " (you can adjust the actual price).";
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

    $("refresh").onclick = () => safe(report);


    // ========================================
    // 15. INITIALIZE APP & RESTORE SESSION
    // ========================================

    document.addEventListener("DOMContentLoaded", () => {
        if (!S || !cfg?.supabaseUrl || !cfg?.supabaseKey) {
            msg("Missing Supabase config.", true);
            return;
        }

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