/* imessage-mcp launcher: runs ONLY the built server with Node and ignores all arguments.
 * It exists so macOS Full Disk Access can be granted to this one program instead of to `node`.
 * Paths are baked in at compile time (see scripts/build-launcher.sh). */
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>
#include <signal.h>
#include <sys/wait.h>

#ifndef NODE_PATH
#error "NODE_PATH not defined"
#endif
#ifndef SERVER_PATH
#error "SERVER_PATH not defined"
#endif

static pid_t child = 0;
static void forward(int sig) { if (child > 0) kill(child, sig); }

int main(void) {
  signal(SIGTERM, forward);
  signal(SIGINT, forward);
  signal(SIGHUP, forward);
  child = fork();
  if (child < 0) { perror("fork"); return 1; }
  if (child == 0) {
    char *argv[] = { "node", SERVER_PATH, NULL };
    execv(NODE_PATH, argv);
    perror("execv node");
    _exit(127);
  }
  int status = 0;
  while (waitpid(child, &status, 0) < 0) { /* retry on EINTR */ }
  return WIFEXITED(status) ? WEXITSTATUS(status) : 1;
}
