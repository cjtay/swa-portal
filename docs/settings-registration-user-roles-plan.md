# Settings Page — Registration User Roles Card

## Context

The settings page (`src/pages/admin/settings.astro`) currently has one card: **Registration — Table Configuration**. This plan adds a second card: **Registration — User Roles**, allowing IT admins to assign `reg_role` values to members from the UI instead of manually editing D1.

### Registration Role System (existing)

| Value | Permissions |
|---|---|
| `reg_admin` | Manage bookings/guests, send magic links (`/api/reg/admin/*`) |
| `reg_volunteer` | Search guests, mark arrivals, add walk-ins (`/api/reg/volunteer/*`) |
| `null` (none) | No registration admin access. All committee members can still check-in guests regardless of this value. |

Data flow: D1 `members.reg_role` → `verify-otp.ts` reads it → session cookie → `middleware.ts` enforces API access → `AdminLayout.astro` controls sidebar nav visibility → `auth-gate.ts` client-side gates.

**Note:** All committee members (`category='committee'` with `can_login=1`) can access check-in features (search, mark arrived, add walk-ins) regardless of their `reg_role` value. `reg_role` only gates registration **admin** features (bookings, exports, magic links).

### Current Gap

There is no UI to assign `reg_role`. It must be done directly in D1. Additionally, the members API PATCH handler's `allowedFields` list does not include `reg_role`.

---

## Changes

### 1. Backend — `src/worker/api/members.ts`

**Line 87** — Add `'reg_role'` to the `allowedFields` array in `handleMemberById`:

```diff
- const allowedFields = ['name', 'slug', 'role', 'email', 'mobile', 'job_title', 'description', 'category', 'can_login', 'show_on_website', 'has_namecard', 'address_line1', 'address_line2', 'address_postal_code', 'address_country', 'facebook', 'linkedin', 'instagram', 'tiktok', 'youtube', 'sort_order', 'photo_url', 'photo_alt'];
+ const allowedFields = ['name', 'slug', 'role', 'email', 'mobile', 'job_title', 'description', 'category', 'can_login', 'show_on_website', 'has_namecard', 'address_line1', 'address_line2', 'address_postal_code', 'address_country', 'facebook', 'linkedin', 'instagram', 'tiktok', 'youtube', 'sort_order', 'photo_url', 'photo_alt', 'reg_role'];
```

This is the only backend change. The existing members API already handles:
- `GET /api/members` — list all members
- `PATCH /api/members/:id` — update individual fields

### 2. Frontend — `src/pages/admin/settings.astro`

Insert a new card after line 42 (after the table config card's `</div>`, before the `<!-- validation-error -->` div).

#### Card HTML

```html
<div class="card settings-card">
  <h2 class="card-title">Registration — User Roles</h2>
  <p class="card-desc">Assign registration access roles to members who can log in. <strong>Registration Admin</strong> can manage bookings and guests. <strong>Registration Volunteer</strong> can search guests and mark arrivals during the event.</p>
  <table class="data-table" id="roles-table">
    <thead>
      <tr>
        <th>Name</th>
        <th>Email</th>
        <th>Current Role</th>
        <th>New Role</th>
      </tr>
    </thead>
    <tbody id="roles-body"></tbody>
  </table>
  <div style="margin-top:1rem;display:flex;align-items:center;gap:1rem;">
    <button class="btn btn-primary btn-sm" id="btn-save-roles">Save Roles</button>
    <span id="roles-save-status" class="save-status"></span>
  </div>
</div>
```

#### JavaScript additions (inside the existing `<script>` block)

```ts
interface Member {
  id: number;
  name: string;
  email: string;
  reg_role: string | null;
}

let membersData: Member[] = [];
let roleChanges: Map<number, string> = new Map(); // member id → new reg_role

async function loadRoles() {
  try {
    const res = await fetch('/api/members');
    if (!res.ok) throw new Error('Failed to load members');
    const json = await res.json();
    if (json.success) {
      membersData = (json.members as Member[])
        .filter((m: any) => m.can_login === 1);
      roleChanges.clear();
      renderRoles();
    }
  } catch (err) {
    console.error('Failed to load members:', err);
  }
}

function renderRoles() {
  const tbody = document.getElementById('roles-body');
  if (!tbody) return;

  if (membersData.length === 0) {
    tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;color:var(--swa-muted,#6b7280);padding:1.5rem;">No members with login access found.</td></tr>';
    return;
  }

  tbody.innerHTML = membersData.map((m) => {
    const currentRole = m.reg_role || '';
    const newRole = roleChanges.has(m.id) ? roleChanges.get(m.id)! : currentRole;
    const badge = currentRole === 'reg_admin'
      ? '<span class="role-badge role-badge-admin">Admin</span>'
      : currentRole === 'reg_volunteer'
        ? '<span class="role-badge role-badge-volunteer">Volunteer</span>'
        : '<span class="role-badge role-badge-none">None</span>';

    const changed = roleChanges.has(m.id);

    return `<tr${changed ? ' style="background:#fffbeb;"' : ''}>
      <td>${esc(m.name)}</td>
      <td style="font-family:monospace;font-size:0.85rem;">${esc(m.email)}</td>
      <td>${badge}</td>
      <td>
        <select class="role-select" data-member-id="${m.id}" data-original="${currentRole}">
          <option value="" ${newRole === '' ? 'selected' : ''}>None</option>
          <option value="reg_volunteer" ${newRole === 'reg_volunteer' ? 'selected' : ''}>Registration Volunteer</option>
          <option value="reg_admin" ${newRole === 'reg_admin' ? 'selected' : ''}>Registration Admin</option>
        </select>
      </td>
    </tr>`;
  }).join('');

  document.querySelectorAll('.role-select').forEach((el) => {
    el.removeEventListener('change', handleRoleChange);
    el.addEventListener('change', handleRoleChange);
  });
}

function handleRoleChange(this: HTMLSelectElement) {
  const memberId = parseInt(this.dataset.memberId || '0', 10);
  const original = this.dataset.original || '';
  const newVal = this.value;

  if (newVal === original) {
    roleChanges.delete(memberId);
  } else if (newVal === '') {
    roleChanges.set(memberId, ''); // explicitly set to null
  } else {
    roleChanges.set(memberId, newVal);
  }

  // Re-render to show changed state
  renderRoles();
}

async function saveRoles() {
  if (roleChanges.size === 0) {
    const status = document.getElementById('roles-save-status')!;
    status.textContent = 'No changes to save.';
    status.className = 'save-status';
    setTimeout(() => { status.textContent = ''; }, 3000);
    return;
  }

  const btn = document.getElementById('btn-save-roles') as HTMLButtonElement;
  const status = document.getElementById('roles-save-status')!;

  btn.disabled = true;
  status.textContent = 'Saving...';
  status.className = 'save-status saving';

  let successCount = 0;
  let failCount = 0;

  const promises = Array.from(roleChanges.entries()).map(async ([memberId, regRole]) => {
    try {
      const res = await fetch(`/api/members/${memberId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reg_role: regRole || null }),
      });
      const json = await res.json();
      if (json.success) {
        successCount++;
      } else {
        failCount++;
      }
    } catch {
      failCount++;
    }
  });

  await Promise.all(promises);

  if (failCount === 0) {
    status.textContent = `${successCount} role${successCount !== 1 ? 's' : ''} updated successfully.`;
    status.className = 'save-status success';
    roleChanges.clear();
    // Refresh data from server
    await loadRoles();
  } else {
    status.textContent = `${successCount} updated, ${failCount} failed. Please try again.`;
    status.className = 'save-status error';
  }

  btn.disabled = false;
  setTimeout(() => {
    if (status.className.includes('success')) {
      status.textContent = '';
      status.className = 'save-status';
    }
  }, 4000);
}
```

Add to `init()` (after existing event listeners):
```ts
document.getElementById('btn-save-roles')!.addEventListener('click', saveRoles);
loadRoles();
```

#### CSS additions (inside the existing `<style>` block)

```css
.role-badge { display: inline-block; font-size: 0.7rem; font-weight: 600; padding: 0.15rem 0.5rem; border-radius: 3px; }
.role-badge-admin { background: var(--swa-1, #70308c); color: #fff; }
.role-badge-volunteer { background: var(--swa-4, #f3d2ff); color: var(--swa-2, #450a5e); }
.role-badge-none { background: #f3f4f6; color: #6b7280; }
.role-select { padding: 0.35rem 0.5rem; border: 1px solid var(--swa-border, #d1d5db); border-radius: 4px; font-size: 0.85rem; font-family: inherit; background: #fff; }
.role-select:focus { outline: none; border-color: var(--swa-3, #874ba1); }
```

---

## Behaviour Summary

| Aspect | Detail |
|---|---|
| **Access** | IT Admin only (enforced by existing `requireItAdmin()` on the page) |
| **Member scope** | Only members with `can_login = 1` (filtered client-side from `GET /api/members`) |
| **Role options** | None, Registration Volunteer (`reg_volunteer`), Registration Admin (`reg_admin`) |
| **Save action** | PATCHes each changed member individually via `PATCH /api/members/:id` with `{ reg_role: newValue }` |
| **Change highlight** | Rows with unsaved changes get a light yellow background |
| **Save bar** | Independent per-card save button with its own status indicator |
| **Post-save** | Reloads member data from server, clears change tracking |
| **No KV** | No KV usage — directly queries D1 via members API |
