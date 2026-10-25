const express = require("express");
const { z } = require("zod");
const { requireAuth, csrfProtect } = require("./auth");
const { validateUrlSafety } = require("./ssrf");
const { listChannels, getChannel, countChannels, createChannel, deleteChannel } = require("./db/alertChannels");
const { testChannel } = require("./notifier");
const { client } = require("./redisClient");

const router = express.Router();
const schema = z.object({
  type: z.enum(["slack", "discord", "webhook"]),
  name: z.string().trim().min(1).max(100),
  target_url: z.string().url(),
  enabled: z.boolean().optional().default(true),
  events: z.array(z.enum(["down", "recovered", "anomaly", "ssl_expiring"])).min(1).optional(),
});
router.get("/", requireAuth, async (req, res) => {
  res.json({ channels: await listChannels(req.user.sub, req.user.role === "admin") });
});
router.post("/", requireAuth, csrfProtect, async (req, res) => {
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues.map((i) => i.message).join(", ") });
  if (await countChannels(req.user.sub) >= 10) return res.status(400).json({ error: "Maximum of 10 alert channels reached" });
  try { await validateUrlSafety(parsed.data.target_url); }
  catch (err) { return res.status(400).json({ error: `SSRF rejected: ${err.message}` }); }
  const channel = await createChannel({ ...parsed.data, userId: req.user.sub, events: parsed.data.events || ["down", "recovered", "anomaly", "ssl_expiring"] });
  res.status(201).json({ channel });
});
router.post("/:id/test", requireAuth, csrfProtect, async (req, res) => {
  const idRaw = req.params.id;
  if (!/^[0-9]+$/.test(idRaw) || !Number.isSafeInteger(Number(idRaw)) || Number(idRaw) < 1) {
    return res.status(400).json({ error: "Channel ID must be a positive integer" });
  }
  const id = Number(idRaw);
  const result = await testChannel(id, req.user.sub, req.user.role === "admin");
  if (!result) return res.status(404).json({ error: "Alert channel not found" });
  res.json({ result });
});
router.patch("/:id", requireAuth, csrfProtect, async (req, res) => {
  const idRaw = req.params.id;
  if (!/^[0-9]+$/.test(idRaw) || !Number.isSafeInteger(Number(idRaw)) || Number(idRaw) < 1) {
    return res.status(400).json({ error: "Channel ID must be a positive integer" });
  }
  const id = Number(idRaw);
  const current = await getChannel(id, req.user.sub, req.user.role === "admin");
  if (!current) return res.status(404).json({ error: "Alert channel not found" });
  const parsed = schema.partial().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues.map((i) => i.message).join(", ") });
  if (parsed.data.target_url) {
    try { await validateUrlSafety(parsed.data.target_url); }
    catch (err) { return res.status(400).json({ error: `SSRF rejected: ${err.message}` }); }
  }
  const fields = parsed.data;
  const assignments = [];
  const values = [];
  for (const [key, value] of Object.entries(fields)) {
    const column = key === "target_url" ? key : key;
    assignments.push(`${column} = $${values.length + 1}`);
    values.push(key === "events" ? JSON.stringify(value) : value);
  }
  if (!assignments.length) return res.status(400).json({ error: "No changes supplied" });
  const idParam = values.length + 1;
  values.push(id);
  const ownerClause = req.user.role === "admin" ? "" : ` AND user_id = $${idParam + 1}`;
  if (req.user.role !== "admin") values.push(req.user.sub);
  const result = await require("./db/pool").query(
    `UPDATE alert_channels SET ${assignments.join(", ")} WHERE id = $${idParam}${ownerClause} RETURNING *`,
    values
  );
  res.json({ channel: require("./db/alertChannels").safeChannel(result.rows[0]) });
});
router.get("/:id/deliveries", requireAuth, async (req, res) => {
  const idRaw = req.params.id;
  if (!/^[0-9]+$/.test(idRaw) || !Number.isSafeInteger(Number(idRaw)) || Number(idRaw) < 1) {
    return res.status(400).json({ error: "Channel ID must be a positive integer" });
  }
  const id = Number(idRaw);
  if (!await getChannel(id, req.user.sub, req.user.role === "admin")) return res.status(404).json({ error: "Alert channel not found" });
  const raw = await client.lrange(`alert-deliveries:${id}`, 0, 49);
  res.json({ deliveries: raw.map((item) => JSON.parse(item)) });
});
router.delete("/:id", requireAuth, csrfProtect, async (req, res) => {
  const idRaw = req.params.id;
  if (!/^[0-9]+$/.test(idRaw) || !Number.isSafeInteger(Number(idRaw)) || Number(idRaw) < 1) {
    return res.status(400).json({ error: "Channel ID must be a positive integer" });
  }
  const id = Number(idRaw);
  if (!await deleteChannel(id, req.user.sub, req.user.role === "admin")) return res.status(404).json({ error: "Alert channel not found" });
  res.json({ message: "Alert channel deleted" });
});
module.exports = router;
