export async function sessionRoutes(app) {
  app.get("/session", async (request) => {
    const actor = request.actor;
    return {
      user: {
        id: actor.userId,
        displayName: actor.displayName,
        role: actor.role,
      },
      tenant: { id: actor.tenantId, name: actor.tenantName || null },
      facilityIds: actor.facilityIds || [],
      ...(actor.csrfToken ? { csrfToken: actor.csrfToken } : {}),
    };
  });
}
