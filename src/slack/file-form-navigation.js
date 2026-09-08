// Pushed file forms are temporary: a successful submission pops the form and refreshes its
// existing parent. Replacing the pushed form with another browser would retain a stack level
// after every save/create and exhaust Slack's three-view limit. Native Cancel still pops the
// untouched form normally. Standalone/root forms have no parent and retain update-in-place.
export function createFileFormNavigation({ ack, client, view }) {
  const parentId = view?.previous_view_id;
  const viewId = parentId || view?.id;
  let acknowledged = false;
  return {
    get acknowledged() { return acknowledged; },
    async show(nextView) {
      if (!acknowledged) {
        if (!parentId) {
          await ack({ response_action: "update", view: nextView });
          acknowledged = true;
          return;
        }
        // An empty submission ack closes only the submitted view. Updating the parent works
        // whether Slack has already revealed it or is still processing that acknowledgement.
        await ack();
        acknowledged = true;
      }
      await client.views.update({ view_id: viewId, view: nextView });
    },
  };
}
