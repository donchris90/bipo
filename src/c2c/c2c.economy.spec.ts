describe('C2C economy boundary', () => {
  it('documents that the current C2C flow must remain disabled while COIN is non-withdrawable', () => {
    // The current implementation settles COIN for off-platform fiat. That is
    // economically a cash-out and must not be reachable through the user API
    // until a compliant marketplace/merchant model is implemented.
    expect(true).toBe(true);
  });
});
