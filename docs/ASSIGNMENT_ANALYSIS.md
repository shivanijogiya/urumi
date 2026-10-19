Urumi AI FDE Internship: Requirements Analysis
1. Problem statement in simple words
Build a Kubernetes-hosted WooCommerce store and a team MCP gateway. An admin registers MCP servers once; team members then access the tools from all enabled servers through one gateway URL, using either an external MCP client or a dashboard chat agent.

The first connected data source must be a WooCommerce store. The gateway must also connect to at least two other MCP servers. The whole system must run locally on Kubernetes and be deployable to a production-like VPS using the same Helm charts with different configuration values.

2. Actual problem being solved
The assignment is testing whether you can combine Kubernetes operations with AI tooling:

Deploy and operate a stateful application, WooCommerce, on Kubernetes.
Build an MCP server for WooCommerce data and actions.
Aggregate multiple upstream MCP servers behind one endpoint.
Provide team identity, access control, credential isolation, and auditability.
Demonstrate an LLM tool loop that acts as the logged-in user.
The pain point implied by the design is duplicated setup and credential exposure: without a gateway, each team member would configure each MCP server separately and potentially handle its credentials. The gateway centralizes upstream connections and gives members one authenticated entry point.

3. Expected solution and deliverables
Required: A working, demonstrable system, not just a design or prototype. It includes:

WooCommerce storefront and admin, running in Kubernetes with persistent database and WordPress content.
A WooCommerce MCP server you write, using Streamable HTTP.
A backend/gateway and React dashboard.
At least three connected upstream MCP servers total: WooCommerce plus two others.
Team users, roles, per-user revocable API keys, and an audit log.
A dashboard chat agent that calls tools through the gateway as the logged-in user.
Helm charts and local/production values, plus a README and short design and threat-model notes.
A demo video showing the required flows, Kubernetes setup, MCP internals, security, and local-to-VPS story.
Submission of the video and GitHub repository through the provided form.
Optional: Multi-store provisioning. Other stand-out items, such as tool permissions, OAuth, security hardening, production VPS deployment, and scaling, are optional unless selected as differentiators. A production-like VPS deployment is particularly valuable but is not part of the mandatory definition of done.

4. Complete requirements checklist
ID
Requirement
Meaning and how to satisfy it
Status / clarification
K1	Run on local Kubernetes	Demonstrate on Kind, k3d, or Minikube.	Explicit; cluster choice is yours.
K2	Same Helm charts for local and VPS	Use Helm, not Kustomize. Configure differences through values files.	Explicit; production-like VPS is a deployment target, but its live deployment is listed as a stand-out.
K3	Everything runs in cluster	Store, database, WooCommerce MCP server, gateway backend, dashboard.	Explicit.
K4	Persistent store data	Persist the database and WordPress content.	Explicit; storage class and backup expectations are unstated.
K5	Ingress and health/resource settings	Expose storefront and dashboard at stable URLs; provide probes and resource requests/limits on every workload.	Explicit; local domain approach must be documented.
K6	No hardcoded secrets	Use Kubernetes Secrets for credentials.	Explicit; key rotation, encryption-at-rest, and secret-management mechanism beyond Kubernetes Secrets are unspecified.
W1	Write WooCommerce MCP server	Do not install an existing WooCommerce MCP server or plugin.	Explicit.
W2	MCP transport and tools	Streamable HTTP; list products, create product, list orders, get order, update order status.	Explicit; schemas, pagination, filters, and validation details need definition.
W3	Restrict WooCommerce MCP access	It must not be reachable from outside the cluster; only the gateway may call it.	Explicit; enforcement method is not prescribed.
W4	Explain store connectivity choice	Document REST API, WP-CLI, or another approach and why.	Explicit documentation requirement; implementation method is your choice.
G1	Admin server management	Add, edit, disable, remove upstream MCP servers; optional static header or bearer credential.	Explicit; credential update and validation flows are not detailed.
G2	Aggregate and route tools	One gateway endpoint lists tools from enabled servers and routes calls to the correct upstream.	Explicit.
G3	Handle tool-name collisions	Two upstreams may use the same tool name; document a naming scheme.	Explicit; exact naming format is your decision.
G4	Upstream failure isolation	Slow/dead servers must not block other servers; use timeouts and clear errors.	Explicit; timeout values and retry/circuit-breaker policy are unspecified.
G5	Protect upstream credentials	Credentials stay server-side, never sent to browser or MCP client.	Explicit.
G6	Minimum upstream count	Connect WooCommerce plus two other MCP servers.	Explicit; which two is your choice.
T1	Roles and team management	At least admin and member roles; admin manages servers and members.	Explicit; exact permissions beyond this are open.
T2	Per-user gateway API keys	Each user has their own key; keys can be revoked and are stored hashed.	Explicit; key generation, display-once, expiry, and recovery behavior are unspecified.
T3	Audit all tool calls	Record user, server, tool, timestamp, duration, and outcome; show logs in dashboard.	Explicit; retention, access control, and redaction rules are unspecified.
C1	Dashboard chat with tools	Use an LLM to call tools through the gateway and show which tools were called.	Explicit; model/provider/design are your choice.
C2	Chat acts as logged-in user	Chat tool calls must be attributed to that user in the audit log.	Explicit.
C3	Protect LLM secrets	LLM API keys follow the same secret-handling rule.	Explicit.
D1	End-to-end store flow	Add product to cart and check out via COD or dummy gateway; confirm order in WooCommerce admin.	Explicit demonstration criterion.
D2	User A chat flow	Create a product through chat; place an order manually; ask for today’s orders and get it back.	Explicit demonstration criterion.
D3	User B external MCP flow	Connect with gateway URL and User B’s key only; see enabled tools and query orders successfully.	Explicit; Claude Code, Cursor, or MCP Inspector accepted.
D4	Cross-server prompt	Run a prompt requiring tools from two different upstream servers.	Explicit; choose a useful, demonstrable scenario.
D5	Key revocation	Revoke User B’s key and show the next call is rejected.	Explicit.
D6	Disable server	Disable an upstream and show its tools disappear from chat and external client.	Explicit.
D7	Kill upstream pod	Show other servers continue working and dashboard reports the failed one unreachable.	Explicit.
D8	Audit attribution	Confirm all demonstrated calls are logged under the correct user.	Explicit.
5. Explicit requirements vs. inferred requirements
Explicit
The checklist above reflects requirements directly stated in the assignment, including Kubernetes and Helm, the WooCommerce MCP tools, gateway behavior, team keys and roles, chat agent behavior, audit logs, test flows, and repository/demo deliverables.

Inferred, but not prescribed as implementation requirements
These are practical implications, not mandates:

The gateway/backend needs some persistent store for users, upstream registrations, API-key hashes, and audit records.
There must be a way to seed or create the initial admin and demonstrate two users.
Tool definitions and routing need a stable identifier when names collide.
The chat agent needs an LLM tool-call loop and a way to authenticate gateway calls as the signed-in user.
The chosen two additional MCP servers should be reliable and support a convincing two-server demonstration.
The assignment does not mandate a programming language, database for gateway metadata, frontend framework beyond React, LLM provider, or specific upstream servers.

Unverified assumptions to avoid
Do not assume the optional multi-store bonus is required.
Do not assume a live VPS is mandatory for passing; it is listed as a differentiator. Still document how the same charts would deploy there.
Do not assume production-grade availability, backups, encryption-at-rest, or a particular authentication flow beyond the stated API keys and roles.
Do not assume “today” has a specified timezone or whether it means order creation time versus payment/completion time.
Do not assume the evaluator will provide WooCommerce credentials, DNS, a VPS, or LLM credits.
6. Functional and non-functional requirements
Functional
Admin registers, edits, disables, and removes upstream MCP servers.
Admin manages users; users generate and use their own gateway API keys.
Gateway exposes tools from all enabled servers and routes calls to the right server.
WooCommerce tools read and modify products and orders.
Dashboard chat invokes tools through the gateway and displays tool usage.
Dashboard displays server health/status, tools, and audit history.
Revoked keys stop working; disabled servers’ tools are no longer available.
Gateway isolates failure of an upstream from other upstreams.
Non-functional and operational
Kubernetes deployment, Helm-based configuration, persistent store data, Ingress exposure, readiness/liveness checks, and resource requests/limits.
No hardcoded secrets; upstream credentials and LLM keys remain server-side.
Tool calls have timeouts and useful failure responses.
WooCommerce MCP is internal-only; gateway is the single route for chat and external clients.
Stable local setup and a documented production-like deployment story.
Unspecified: quantitative latency/availability targets, concurrency/load expectations, audit retention, backup/restore objectives, and formal security/compliance standards.

7. Users, use cases, and workflows
Admin

Sees configured servers, status, and tools.
Adds and manages servers and credentials.
Invites/manages members and issues or revokes keys.
Reviews tool-call audit records.
Member

Generates their own API key.
Uses one gateway URL plus their key in an MCP client.
Uses the dashboard chat without seeing upstream credentials.
Core workflow

Admin configures upstream servers, including the pre-registered WooCommerce server.
Gateway connects to each enabled upstream and aggregates its tools.
Member authenticates with their own key, via an external client or dashboard.
Gateway authenticates and attributes the request, selects the correct upstream, and forwards the call using any server-side upstream credential.
Gateway returns the result and records the call’s user, server, tool, time, duration, and outcome.
The assignment requires this behavior; the exact MCP session lifecycle and authentication handshake details are not specified and must be designed and documented.

8. System components and responsibilities
Component
Purpose
Inputs and outputs
Key requirements
WooCommerce store	Storefront and order administration	Customer actions create products/orders; admin can inspect orders.	K1–K6, D1
Store database and persistent volumes	Retain store state across pod restarts.	WordPress/WooCommerce reads and writes data.	K4
WooCommerce MCP server	Convert MCP tool calls into store operations.	MCP requests in; product/order results or errors out.	W1–W4
Gateway backend	Authenticate users, manage upstreams, aggregate tools, route calls, enforce timeouts, record audit data.	Client/chat MCP requests in; upstream tool calls/results out.	G1–G5, T2–T3
Dashboard	Admin and member interface, server status/tools, users/keys, audit log, chat.	User actions and chat prompts in; management views and responses out.	G1, T1–T3, C1
Chat agent	Ask the LLM to select and invoke tools through the gateway as the current user.	User prompt in; tool calls and answer out.	C1–C3
Two additional MCP servers	Prove the gateway is genuinely multi-server.	Their own tools and results.	G6, D4
Helm charts and values	Deploy the full system consistently in local and production-like environments.	Values configure environment-specific settings.	K1–K2
Required component boundary: both the dashboard chat agent and external MCP clients access upstream tools through the gateway. Nothing else should call upstream MCP servers directly.

9. Scope: what to build and what not to build
In scope
One WooCommerce store.
Custom WooCommerce MCP server with the five specified tools.
Gateway supporting Streamable HTTP upstreams, credentials, aggregation, routing, collisions, timeouts, and isolation.
React dashboard/backend, admin/member roles, user API keys, audit log, and tool-using chat.
Two additional upstream MCP servers.
Local Kubernetes deployment with Helm and a documented production-like configuration path.
Working, two-user demo and required repository documentation.
Not mandatory
Multi-store provisioning; it is explicitly a bonus.
OAuth, fine-grained tool permissions, hosted MCP servers, rate limits, gateway high availability, or production monitoring.
Live public VPS deployment, though it can strengthen the submission.
A high-quality or domain-specialized LLM answer; the assignment says the working tool loop matters more.
10. Acceptance criteria and success metrics
The following are directly testable from the assignment:

The storefront supports adding a product to cart and completing a test-friendly checkout; the order appears in WooCommerce admin.
User A asks the dashboard agent to create a named, priced product; that product appears on the storefront.
After a manual storefront order, User A asks what orders came in today; the answer includes that order.
User B connects an external MCP client using only the gateway URL and User B’s key, sees tools from enabled servers, and successfully queries orders.
A single prompt uses tools from two distinct upstream servers.
Revoking User B’s key causes their next call to be rejected.
Disabling an upstream removes its tools from both chat and external-client tool listings.
Killing one upstream pod makes the dashboard show it as unreachable while other upstreams continue to work.
Every demonstrated tool call appears in the audit log with correct user, server, tool, timestamp, duration, and outcome.
The required Kubernetes resources and deployment setup are present and demonstrable, including persistence, Ingress, probes, resource requests/limits, and secret handling.
The submitted repository includes the stated source, charts, values, setup instructions, design/tradeoffs note, and threat-model note.
Suggested criteria requiring validation: define acceptable timeout duration, expected status refresh interval, audit-log retention, and the exact “today” timezone/order timestamp convention.

11. Missing information, ambiguities, and risks
“Today” semantics: timezone and which order timestamp/counting status to use are unspecified.
MCP interoperability: protocol version, session handling, gateway endpoint path, and client compatibility expectations are not detailed.
User lifecycle: invite mechanism, initial admin setup, password/login method, and key display/recovery rules are unspecified.
Upstream registration: no required validation or credential-testing UX is specified.
Tool-name collisions: behavior must be chosen and documented; clients and chat must use the same names.
Audit details: retention, pagination, filtering, and sensitive argument/result redaction are not specified.
Data durability: persistence is required for WordPress and its database, but backup/restore and gateway metadata durability are not specified.
Failure semantics: timeout thresholds and whether listing tools should omit or mark tools from unreachable upstreams need a clear policy.
Security risk: arbitrary admin-supplied URLs create SSRF risk, including access to internal services or metadata endpoints. SSRF hardening is an optional stand-out item, but the demo requires proving the system’s security posture and discussing malicious/compromised upstreams.
Tool-description risk: upstream descriptions may manipulate an LLM. The threat-model note must address this explicitly.
Two additional servers: choice affects the cross-server prompt and demo reliability; not specified by the employer.
Two-week constraint: the assignment explicitly prioritizes a working core over unfinished bonuses. Multi-store provisioning should not displace mandatory end-to-end flows.
12. Prioritized questions for the company
What timezone and timestamp define “orders came in today”? This affects the required chat demonstration and correctness.
What login/authentication method is expected for the dashboard? API keys are specified for MCP clients, but the dashboard’s user authentication flow is not.
Are there preferred or prohibited choices for the two additional upstream MCP servers? This affects the cross-server demonstration.
What MCP client/version and Streamable HTTP behavior will the evaluators use? This can affect endpoint and session compatibility.
How should unavailable upstream tools appear in tool listings: hidden, or listed with an unavailable status? The assignment says failures must not break other servers, but does not define listing behavior.
Are there expected audit retention or redaction rules? Tool inputs may contain sensitive order/customer data.
Will a VPS, DNS, or specific ingress/storage setup be provided for a production-like deployment? This determines whether live VPS deployment is feasible within the two weeks.
13. Concise summary: exactly what to build
Build a Helm-deployed Kubernetes system with one persistent WooCommerce store, your own internal-only WooCommerce MCP server, a React dashboard/backend gateway aggregating at least two additional MCP servers, and a chat agent that invokes tools through that gateway as the signed-in user. Add admin/member roles, individually revocable hashed API keys, server-side upstream credentials, health/status views, and per-call audit logging. Demonstrate the required two-user store, chat, external-client, revocation, disablement, and upstream-failure flows; provide local and production-like Helm configuration plus the required README, design/tradeoff note, threat model, repository, and demo video. Leave multi-store provisioning and other bonuses until this core works end to end.