/** An error whose message is meant to be shown to the bookkeeper. */
export class AppError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
