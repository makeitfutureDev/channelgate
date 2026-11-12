// New users opt in; migrations explicitly preserve mentions for existing users.
export function userReplyMentionsEnabled(user) {
  return user?.replyMentions === true;
}
