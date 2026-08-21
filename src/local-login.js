const form = document.querySelector("#local-login-form");
const error = document.querySelector("#login-error");

form?.addEventListener("submit", async (event) => {
  event.preventDefault();
  error.hidden = true;
  for (const input of form.querySelectorAll("input")) input.removeAttribute("aria-invalid");
  const submit = form.querySelector("button[type='submit']");
  submit.disabled = true;
  submit.setAttribute("aria-busy", "true");
  try {
    const response = await fetch("/auth/local/login", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        email: form.elements.email.value,
        password: form.elements.password.value,
      }),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) throw new Error(payload?.error?.message || "ログインできませんでした。");
    window.location.assign(payload?.redirectTo || "/");
  } catch (cause) {
    error.textContent = cause.message;
    error.hidden = false;
    for (const input of form.querySelectorAll("input")) input.setAttribute("aria-invalid", "true");
    submit.disabled = false;
    submit.removeAttribute("aria-busy");
  }
});
