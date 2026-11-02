#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>
#include <stdio.h>

int main(void) {
  pid_t child = fork();
  if (child < 0) return 2;
  if (child == 0) {
    if (setpgid(0, 0) < 0) _exit(3);
    _exit(0);
  }

  /* WNOWAIT holds the exited group member until the test releases stdin. */
  siginfo_t info = {0};
  if (waitid(P_PID, child, &info, WEXITED | WNOWAIT) < 0) {
    perror("waitid");
    return 4;
  }
  if (info.si_status != 0) {
    waitpid(child, NULL, 0);
    return 5;
  }
  printf("%d\n", child);
  fflush(stdout);
  getchar();
  if (waitpid(child, NULL, 0) < 0) return 6;
  return 0;
}
