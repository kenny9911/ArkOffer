import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../../server/app.js";
import { createDatabase } from "../../server/db.js";

test("members see only owned/shared interviews across lists, exports, versions, files and editing", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "arkoffer-access-")),
    store = createDatabase(directory),
    origin = "http://localhost:5174";
  const app = createApp({ store, appOrigin: origin, openAiApiKey: "" });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const call = (cookie: string, path: string, method = "GET", body?: unknown) =>
    fetch(base + "/api/" + path, {
      method,
      headers: {
        Origin: origin,
        Cookie: cookie,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  const signup = async (name: string) => {
    const r = await call("", "auth/signup", "POST", {
      name,
      email: `${name}@example.com`,
      password: "safe-test-password-890",
    });
    assert.equal(r.status, 201);
    return {
      cookie: r.headers.get("set-cookie")!.split(";")[0],
      user: (await r.json()).user,
    };
  };
  const owner = await signup("access-owner"),
    member = await signup("access-member"),
    stranger = await signup("access-stranger");
  const invite = await (
    await call(owner.cookie, "team/invitations", "POST", {
      email: member.user.email,
      role: "member",
    })
  ).json();
  const invitationToken = invite.item?.url?.split("/").pop();
  assert.ok(invitationToken, JSON.stringify(invite));
  assert.equal(
    (
      await call(
        member.cookie,
        `invitations/${invitationToken}/accept`,
        "POST",
        {},
      )
    ).status,
    200,
  );
  const created = await (
    await call(owner.cookie, "conversations", "POST", {
      title: "Private interview",
      transcript: "Candidate: I work with TypeScript.",
      sections: [],
    })
  ).json();
  const id = created.item.id;
  for (const path of [
    `conversations/${id}`,
    `conversations/${id}/versions`,
    `conversations/${id}/file`,
    `conversations/${id}/media`,
    `conversations/${id}/comments`,
  ])
    assert.equal((await call(member.cookie, path)).status, 404, path);
  assert.deepEqual(
    (await (await call(member.cookie, "conversations")).json()).items,
    [],
  );
  assert.equal(
    (
      await (
        await call(member.cookie, "reports/export?resource=conversations")
      ).text()
    ).includes("Private interview"),
    false,
  );
  assert.equal(
    (
      await call(
        owner.cookie,
        `conversations/${id}/access/${stranger.user.id}`,
        "PUT",
        { permission: "viewer" },
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await call(
        owner.cookie,
        `conversations/${id}/access/${member.user.id}`,
        "PUT",
        { permission: "viewer" },
      )
    ).status,
    200,
  );
  const shared = await (
    await call(member.cookie, `conversations/${id}`)
  ).json();
  assert.equal(shared.item.access.canEdit, false);
  assert.equal(
    (
      await call(member.cookie, `conversations/${id}`, "PATCH", {
        title: "Hijacked",
      })
    ).status,
    403,
  );
  assert.equal(
    (await call(member.cookie, `conversations/${id}/generate`, "POST", {}))
      .status,
    403,
  );
  assert.equal(
    (await call(member.cookie, `conversations/${id}/shares`, "POST", {}))
      .status,
    403,
  );
  assert.equal(
    (
      await call(member.cookie, `conversations/${id}/assistant`, "POST", {
        question: "TypeScript",
      })
    ).status,
    200,
  );
  const comment = await (
    await call(member.cookie, `conversations/${id}/comments`, "POST", {
      body: "Please arrange a follow-up.",
    })
  ).json();
  assert.equal(comment.item.body, "Please arrange a follow-up.");
  const ownerComment = await (
    await call(owner.cookie, `conversations/${id}/comments`, "POST", {
      body: "Owner feedback",
    })
  ).json();
  assert.equal(
    (
      await call(
        member.cookie,
        `conversations/${id}/comments/${ownerComment.item.id}`,
        "DELETE",
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await call(
        member.cookie,
        `conversations/${id}/comments/${comment.item.id}`,
        "DELETE",
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await call(
        owner.cookie,
        `conversations/${id}/access/${member.user.id}`,
        "PUT",
        { permission: "editor" },
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await call(member.cookie, `conversations/${id}`, "PATCH", {
        tldr: "Updated by teammate",
      })
    ).status,
    200,
  );
  assert.equal(
    (await call(member.cookie, `conversations/${id}`, "DELETE")).status,
    403,
  );
  assert.equal(
    (
      await call(member.cookie, `conversations/${id}/access`, "PATCH", {
        visibility: "workspace",
      })
    ).status,
    403,
  );
  const collection = (
    await (
      await call(member.cookie, "collections", "POST", {
        name: "Member private folder",
      })
    ).json()
  ).item;
  assert.equal(
    (
      await call(member.cookie, `conversations/${id}`, "PATCH", {
        collectionIds: [collection.id],
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await call(
        owner.cookie,
        `conversations/${id}/access/${member.user.id}`,
        "DELETE",
      )
    ).status,
    200,
  );
  assert.equal((await call(member.cookie, `conversations/${id}`)).status, 404);
  assert.equal(
    (
      await call(owner.cookie, `conversations/${id}/access`, "PATCH", {
        visibility: "workspace",
      })
    ).status,
    200,
  );
  assert.equal((await call(member.cookie, `conversations/${id}`)).status, 200);
  assert.equal(
    (await call(stranger.cookie, `conversations/${id}`)).status,
    404,
  );
  assert.equal(
    (
      await call(owner.cookie, `conversations/${id}/access`, "PATCH", {
        visibility: "private",
      })
    ).status,
    200,
  );
  const folder = (
    await (
      await call(owner.cookie, "collections", "POST", {
        name: "Shared collection",
      })
    ).json()
  ).item;
  assert.equal(
    (
      await call(owner.cookie, `conversations/${id}`, "PATCH", {
        collectionIds: [folder.id],
      })
    ).status,
    200,
  );
  assert.equal(
    (await call(member.cookie, `collections/${folder.id}`)).status,
    404,
  );
  assert.equal(
    (
      await call(
        owner.cookie,
        `collections/${folder.id}/access/${member.user.id}`,
        "PUT",
        { permission: "viewer" },
      )
    ).status,
    200,
  );
  assert.equal((await call(member.cookie, `conversations/${id}`)).status, 200);
  assert.equal(
    (
      await call(member.cookie, `conversations/${id}`, "PATCH", {
        tldr: "Should fail",
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await call(
        owner.cookie,
        `collections/${folder.id}/access/${member.user.id}`,
        "DELETE",
      )
    ).status,
    200,
  );
  assert.equal((await call(member.cookie, `conversations/${id}`)).status, 404);
  const own = (
    await (
      await call(member.cookie, "conversations", "POST", {
        title: "Member interview",
      })
    ).json()
  ).item;
  assert.equal(
    (await (await call(member.cookie, `conversations/${own.id}`)).json()).item
      .access.ownerId,
    member.user.id,
  );
  assert.equal(
    (await call(owner.cookie, `conversations/${own.id}`)).status,
    200,
  );
  assert.equal(
    (
      await call(member.cookie, "settings", "PATCH", {
        workspaceName: "Forbidden change",
      })
    ).status,
    403,
  );
  assert.equal(
    (await call(member.cookie, "settings", "PATCH", { name: "Allowed change" }))
      .status,
    200,
  );
});
