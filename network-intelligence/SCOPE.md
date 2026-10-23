# Interface 4: Food Network Intelligence — Scope

## ✅ Build Now (Operational Dashboard)

These sections are data-display and coordination-focused — buildable without ML models:

| Section | Description |
|---|---|
| **Network Overview** | Live stats — total surplus, total demand, active matches, fulfillment rate, waste prevented |
| **Live Supply & Demand** | Current surplus postings + active demand registrations across the network |
| **Active Redistributions** | Ongoing matches, status tracking (Finding → Matched → In Progress → Completed) |
| **Network Rebalancing** | Area-level surplus/deficit view — which zones have excess, which have unmet demand |
| **Fallback / Reserve Allocation** | Surplus with no immediate demand → route to food banks/storage. Hierarchy panel. |
| **Community Food Intelligence** | Surplus hotspots, demand hotspots, access gaps, underserved areas (list/summary view) |
| **⚠️ Waste-Risk Alerts** | Food approaching expiry with no match — proactive list with intervention options |
| **💡 Intervention Recommendations** | Rule-based suggestions: redirect X to Y, expand capacity in Z, address recurring waste |
| **📊 Network Metrics** | Charts: total surplus trend, fulfillment rate, unmet demand, successful redistributions |

---

## 🔜 Deferred — Needs ML/AI Models (Mention in UI as "Coming Soon")

| Section | Why Deferred |
|---|---|
| **🔮 Supply Prediction** | Requires trained model on donor historical data — surplus prediction per donor/day |
| **🔮 Demand Prediction** | Requires demand trend modeling — predicted demand hotspots, seasonal patterns |
| **🧠 Prediction Accuracy / Learning** | Requires predicted-vs-actual feedback loop, model retraining pipeline |
| **⚙️ Advanced Optimization Engine** | Network-wide LP/graph optimization — requires solver integration (e.g. OR-Tools) |
| **Recurring Pattern Detection** | Automated clustering of surplus/demand patterns — needs sufficient historical data |

These will be surfaced as locked/coming-soon panels in the dashboard UI so the structure is visible but not misleading.

---

## Users
Authorized network coordinators / community managers / ecosystem authorities.

## Core Principle
> The network intelligence layer receives data from all other interfaces and performs coordination, optimization, and network-level analysis. This is not duplicated in Admin.
