// Admin API for ENGINE licenses (src/config/engine-licenses.js): the credentials a harness can
// run on, beyond the ones the gateway ships with. Mounted under the admin router, so the admin
// session authenticates every route; the run-API key never reaches them.
//
// Named `/engine-licenses` on purpose — `/license` is the ChannelGate product license.
//
// Nothing here returns a credential. A license's key or service-account key is written and never
// read back: the listing carries `hasApiKey` + `apiKeyLast4` (or `hasServiceAccount` + the account's
// address), and there is no reveal route.
//
// The licenses the gateway SHIPS with are not records, but the same three verbs reach them: PUT
// renames a harness's own sign-in, DELETE removes any other shipped license (off, unlisted, its own
// credential deleted) and POST …/restore lists it again.
import express from "express";
import {
  EngineLicenseError, createLicense, deleteLicense, getLicenseRecord, licenseCatalog, licenseForApi,
  licenseStatusFor, listLicensesForApi, listRemovedBuiltinLicenses, removeBuiltinLicense, renameBuiltinLicense,
  restoreBuiltinLicense, updateLicense, verifyLicense,
} from "../../config/engine-licenses.js";
import { engineRegistry } from "../../engines/registry.js";
import { isProviderKind } from "../../engines/license-state.js";
import { cancelLicenseCodexLogin, licenseCodexLoginStatus, startLicenseCodexLogin } from "../../gateway/channel-codex-login.js";
import { getChannelEntry } from "../../config/store.js";
import { logEvent } from "../../util/logger.js";

const ADMIN_UI = "admin-ui";
// Only the fields a form may set; everything else on the record is the gateway's.
const formFields = (body = {}) => ({
  kind: body.kind, label: body.label, type: body.type,
  baseUrl: body.baseUrl, apiKey: body.apiKey, authScheme: body.authScheme, models: body.models,
  region: body.region, projectId: body.projectId, serviceAccount: body.serviceAccount, apiVersion: body.apiVersion,
  // The one conversation the license is limited to: "" for every conversation, absent = unchanged.
  channelId: body.channelId,
});
// A limit names a conversation this gateway knows. Checked here, where the channel index is, and
// only for a limit being SET: an unchanged or cleared one needs no conversation to exist.
async function assertKnownConversation(channelId, previous = "") {
  if (typeof channelId !== "string" || !channelId.trim() || channelId.trim() === previous) return;
  if (!(await getChannelEntry(channelId.trim()))) throw new EngineLicenseError("That conversation is not known to this gateway. Choose one from the list.", 400);
}
// What an audit row may say changed: names only, and for a credential only THAT it changed.
const PLAIN_FIELDS = ["label", "type", "baseUrl", "authScheme", "region", "projectId", "apiVersion", "channelId"];
const SECRET_FIELDS = ["apiKey", "serviceAccount"];

export function createLicensesRouter({ verify = verifyLicense } = {}) {
  const router = express.Router();
  const fail = (res, next, error) => {
    if (error instanceof EngineLicenseError) return res.status(error.status).json({ ok: false, error: error.message });
    if (error?.statusCode) return res.status(error.statusCode).json({ ok: false, error: error.message });
    return next(error);
  };
  const withStatus = async (record) => ({ ...licenseForApi(record), status: await licenseStatusFor(record.id) });
  const isBuiltin = (id) => engineRegistry.isBuiltin(id);

  router.get("/engine-licenses", async (_req, res, next) => {
    res.set("Cache-Control", "no-store");
    try { res.json({ ok: true, catalog: licenseCatalog(), licenses: await listLicensesForApi(), removed: listRemovedBuiltinLicenses() }); } catch (error) { fail(res, next, error); }
  });

  router.post("/engine-licenses", async (req, res, next) => {
    try {
      const fields = formFields(req.body);
      await assertKnownConversation(fields.channelId);
      const record = createLicense(fields);
      await logEvent("engine_license_added", { license: record.id, harness: record.harness, kind: record.kind, type: record.type, name: record.label, ...(record.channelId ? { limitedTo: record.channelId } : {}), author: ADMIN_UI });
      // A provider license is checked against its server as soon as it exists; a sign-in license
      // has nothing to check until someone signs it in.
      const verification = isProviderKind(record.kind) ? (await verify(record.id).catch(() => null))?.verification || null : null;
      res.status(201).json({ ok: true, license: await withStatus(getLicenseRecord(record.id) || record), verification });
    } catch (error) { fail(res, next, error); }
  });

  router.put("/engine-licenses/:id", async (req, res, next) => {
    try {
      // A shipped license has one editable fact: the name of a harness's own sign-in.
      if (isBuiltin(req.params.id)) {
        const license = renameBuiltinLicense(req.params.id, req.body?.label);
        if (license.label !== license.previousLabel) {
          await logEvent("engine_license_changed", { license: license.id, harness: license.harness, name: license.label, previousName: license.previousLabel, changed: ["label"], author: ADMIN_UI });
        }
        return res.json({ ok: true, license });
      }
      const before = getLicenseRecord(req.params.id);
      const { kind: _kind, ...fields } = formFields(req.body);
      await assertKnownConversation(fields.channelId, before?.channelId || "");
      const record = updateLicense(req.params.id, fields);
      const changed = PLAIN_FIELDS.filter((key) => before && (before[key] ?? "") !== (record[key] ?? ""));
      for (const key of SECRET_FIELDS) if (before && (before[key] ?? "") !== (record[key] ?? "")) changed.push(key);
      if (before && JSON.stringify(before.models || []) !== JSON.stringify(record.models || [])) changed.push("models");
      await logEvent("engine_license_changed", { license: record.id, harness: record.harness, name: record.label, changed, ...(changed.includes("channelId") ? { limitedTo: record.channelId || "", previousLimit: before?.channelId || "" } : {}), author: ADMIN_UI });
      const reverify = isProviderKind(record.kind) && !record.verification;
      const verification = reverify ? (await verify(record.id).catch(() => null))?.verification || null : null;
      res.json({ ok: true, license: await withStatus(getLicenseRecord(record.id) || record), verification });
    } catch (error) { fail(res, next, error); }
  });

  router.delete("/engine-licenses/:id", async (req, res, next) => {
    try {
      if (isBuiltin(req.params.id)) {
        const license = await removeBuiltinLicense(req.params.id);
        await logEvent("engine_license_removed", { license: license.id, harness: license.harness, kind: "builtin", name: license.engineLabel, author: ADMIN_UI });
        return res.json({ ok: true, removed: license.id, restorable: true });
      }
      cancelLicenseCodexLoginSafe(req.params.id);
      const record = await deleteLicense(req.params.id);
      await logEvent("engine_license_removed", { license: record.id, harness: record.harness, kind: record.kind, name: record.label, author: ADMIN_UI });
      res.json({ ok: true, removed: record.id });
    } catch (error) { fail(res, next, error); }
  });

  // Lists a removed shipped license again — switched off and without a credential, as a fresh
  // install has it.
  router.post("/engine-licenses/:id/restore", async (req, res, next) => {
    try {
      const license = restoreBuiltinLicense(req.params.id);
      await logEvent("engine_license_restored", { license: license.id, harness: license.harness, kind: "builtin", name: license.engineLabel, author: ADMIN_UI });
      res.json({ ok: true, license });
    } catch (error) { fail(res, next, error); }
  });

  router.post("/engine-licenses/:id/verify", async (req, res, next) => {
    try {
      const result = await verify(req.params.id);
      await logEvent("engine_license_verified", { license: req.params.id, ok: Boolean(result.verification?.ok), verified: Boolean(result.verification?.verified), author: ADMIN_UI });
      res.json({ ok: true, ...result });
    } catch (error) { fail(res, next, error); }
  });

  // A Codex license's ChatGPT sign-in, by device code, into that license's own directory. The
  // routes return status or a device code — never auth.json. A Claude sign-in license is signed
  // in on the gateway host with the command the listing carries (`loginCommand`).
  const codexLicense = (req) => {
    const record = getLicenseRecord(req.params.id);
    if (!record) throw new EngineLicenseError("That license no longer exists.", 404);
    if (record.kind !== "codex-login") throw new EngineLicenseError("Only a ChatGPT sign-in license is signed in here.", 400);
    return record;
  };
  router.get("/engine-licenses/:id/login", async (req, res, next) => {
    try { res.json(await licenseCodexLoginStatus(codexLicense(req).id)); } catch (error) { fail(res, next, error); }
  });
  router.post("/engine-licenses/:id/login", async (req, res, next) => {
    try {
      const record = codexLicense(req);
      const status = await startLicenseCodexLogin(record.id, {
        onAuthenticated: () => logEvent("engine_license_signed_in", { license: record.id, harness: record.harness, name: record.label, author: ADMIN_UI }),
      });
      res.status(202).json(status);
    } catch (error) { fail(res, next, error); }
  });
  router.delete("/engine-licenses/:id/login", (req, res, next) => {
    try { res.json({ cancelled: cancelLicenseCodexLogin(codexLicense(req).id) }); } catch (error) { fail(res, next, error); }
  });

  return router;
}

function cancelLicenseCodexLoginSafe(id) {
  try { cancelLicenseCodexLogin(id); } catch { /* not a Codex license, or nothing pending */ }
}
