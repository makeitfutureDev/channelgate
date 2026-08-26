import test from "node:test";
import assert from "node:assert/strict";
import {
  channelGuestAcceptedIds,
  channelGuestSavePatch,
  loadChannelGuestOptions,
} from "../public/admin-state.js";

test("guest options load only from the selected channel's encoded member endpoint", async () => {
  const paths = [];
  const request = async (path) => {
    paths.push(path);
    return {
      members: [
        { id: "U_INTERNAL", name: "Internal Person", isExternal: false },
        { id: "U_EXTERNAL", name: "External Person", isExternal: true },
      ],
    };
  };

  assert.deepEqual(await loadChannelGuestOptions(request, "C/SELECTED"), [
    { value: "U_INTERNAL", label: "Internal Person (U_INTERNAL)" },
    { value: "U_EXTERNAL", label: "External Person (U_EXTERNAL) · external" },
  ]);
  assert.deepEqual(paths, ["/api/channels/C%2FSELECTED/members"]);
});

test("guest options reject malformed roster payloads instead of falling back to org users", async () => {
  await assert.rejects(
    loadChannelGuestOptions(async () => ({ members: null }), "C_SELECTED"),
    /valid member roster/i,
  );
});

test("channel save omits guest grants until the live roster loaded successfully", () => {
  assert.deepEqual(channelGuestSavePatch(false, ["U_EXISTING"]), {});
  assert.deepEqual(channelGuestSavePatch(true, ["U_EXTERNAL", "U_EXTERNAL", "U_INTERNAL"]), {
    allowedUsers: ["U_EXTERNAL", "U_INTERNAL"],
  });
});

test("successful saves expose the server-accepted guest IDs for checklist repainting", () => {
  assert.equal(channelGuestAcceptedIds(false, ["U_MEMBER"]), null);
  assert.deepEqual(
    channelGuestAcceptedIds(true, ["U_MEMBER", "U_MEMBER", "U_EXTERNAL"]),
    ["U_MEMBER", "U_EXTERNAL"],
  );
});
