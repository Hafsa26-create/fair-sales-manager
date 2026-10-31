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
        } catch (error) {
            activeUserId = null;
            throw error;
        }
    }


    // ========================================
    // 4. FAIR LOADING & SELECTION
    // ========================================

    async function loadFairs() {
        fairs = await data(
            db
                .from("fair_sales_fairs")
                .select("*")
                .order("created_at", { ascending: false })
        );

        const ms = await data(
            db
                .from("fair_sales_memberships")
                .select("fair_id,role")
                .eq("user_id", user.id)
        );

        const roles = new Map(
            ms.map((m) => [m.fair_id, m.role])
        );

        fairs = fairs
            .filter((f) => roles.has(f.id))
            .map((f) => ({
                ...f,
                role: roles.get(f.id)
            }));

            
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
        const f = fairs[0];

        $("fairSelect").value = f.id;

        await chooseFair(f.id);
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

    async function chooseFair(id) {
        if (channel) {
            await db.removeChannel(channel);
            channel = null;
        }

        fair = fairs.find((f) => f.id === id) || null;
        role = fair?.role || null;
        finance = null;
        products = [];

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
        }

        await loadProducts();

        if (role === "owner") {
            await report();
            subscribe();
        }
    }


    // ========================================
    // 5. PRODUCTS & BUYING PRICES
    // ========================================

    async function loadProducts() {
        products = await data(
            db
                .from("fair_sales_products")
                .select("id,fair_id,product_code,active")
                .eq("fair_id", fair.id)
                .eq("active", true)
                .order("product_code")
        );

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
                                <small>Buying price / piece</small>
                            </span>
                            <b>
                                ${
                                    p.buying_price === undefined
                                        ? "Not set"
                                        : money(p.buying_price)
                                }
                            </b>
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
                                <th>Price</th>
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

                                    const c =
                                        Number(s.quantity) *
                                        (cost.get(s.product_id) || 0);

                                    return `
                                        <tr>
                                            <td>${esc(new Date(s.created_at).toLocaleString())}</td>
                                            <td>${esc(p?.product_code || "Product")}</td>
                                            <td>${s.quantity}</td>
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
                unit_selling_price < 0
            ) {
                throw Error(
                    "Enter valid product, quantity and price."
                );
            }

            await data(
                db
                    .from("fair_sales_entries")
                    .insert({
                        fair_id: fair.id,
                        product_id,
                        quantity,
                        unit_selling_price,
                        entered_by: user.id
                    })
            );

            $("entryStatus").textContent =
                `Saved: ${
                    products.find((p) => p.id === product_id)?.product_code
                }, ${quantity} pcs at ${money(unit_selling_price)} each.`;

            $("qty").value = 1;
            $("price").value = "";
            $("total").textContent = money(0);

            msg("Sale saved successfully.");
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

            const p = await data(
                db
                    .from("fair_sales_products")
                    .upsert(
                        {
                            fair_id: fair.id,
                            product_code: $("code").value.trim(),
                            active: true
                        },
                        {
                            onConflict: "fair_id,product_code"
                        }
                    )
                    .select("*")
                    .single()
            );

            await data(
                db
                    .from("fair_sales_product_costs")
                    .upsert(
                        {
                            product_id: p.id,
                            fair_id: fair.id,
                            buying_price: +$("buying").value
                        },
                        {
                            onConflict: "product_id"
                        }
                    )
            );

            e.target.reset();

            await loadProducts();

            msg("Product and buying price saved.");
        } catch (e) {
            msg(e.message, true);
        }
    };


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
               
   async function testOwnerCheck() {
    const { data: userData, error: userError } =
        await db.auth.getUser();

    const { data: ownerData, error: ownerError } =
        await db.rpc("fair_sales_is_existing_owner");

    console.log("Auth user:", {
        id: userData?.user?.id,
        error: userError
    });

    console.log("Existing owner:", {
        data: ownerData,
        error: ownerError
    });
}
testOwnerCheck();


        $("expenseDate").value =
            new Date().toISOString().slice(0, 10);

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