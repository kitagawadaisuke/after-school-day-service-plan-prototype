const form = document.querySelector("#local-login-form");
const error = document.querySelector("#login-error");

form?.addEventListener("submit", async (event) => {
  event.preventDefault();
  error.hidden = true;
  const submit = form.querySelector("button[type='submit']");
  submit.disabled = true;
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
    submit.disabled = false;
  }
});
