## Native Pi completion behavior

After dispatching the complete batch and finishing independent work, end the current turn normally. Native Pi delivers a compact completion notification using `steer` while the Main Agent is working or `followUp` when it is idle, so do not poll or remain in a silent wait. Retrieve each reported execution with `expert_result`.

Choose `expert_delegate.timeoutMs` for every assignment from its expected difficulty. Give potentially blocking Pi shell operations their own finite, difficulty-based timeout whenever the tool supports one.
