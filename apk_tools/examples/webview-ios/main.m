#import <UIKit/UIKit.h>
#import <WebKit/WebKit.h>
#import <arpa/inet.h>
#import <sys/socket.h>
#import <unistd.h>

static NSURL *BFSPrivateFile(NSString *name) {
  NSURL *directory = [[[NSFileManager defaultManager] URLsForDirectory:NSApplicationSupportDirectory
                                                           inDomains:NSUserDomainMask] firstObject];
  [[NSFileManager defaultManager] createDirectoryAtURL:directory withIntermediateDirectories:YES attributes:nil error:nil];
  return [directory URLByAppendingPathComponent:name];
}

static NSMutableArray *BFSReadArray(NSString *name) {
  NSData *raw = [NSData dataWithContentsOfURL:BFSPrivateFile(name)];
  id result = raw ? [NSJSONSerialization JSONObjectWithData:raw options:0 error:nil] : nil;
  if (raw && ![result isKindOfClass:NSArray.class]) {
    [NSException raise:@"OwnedFixtureStateInvalid" format:@"%@", name];
  }
  return result ? [result mutableCopy] : [NSMutableArray array];
}

static void BFSWriteJSON(id value, NSString *name) {
  NSData *encoded = [NSJSONSerialization dataWithJSONObject:value options:0 error:nil];
  if (!encoded || ![encoded writeToURL:BFSPrivateFile(name) options:NSDataWritingAtomic error:nil]) {
    [NSException raise:@"OwnedFixturePersistenceFailed" format:@"%@", name];
  }
}

static NSString *BFSArgument(NSString *name) {
  NSArray *arguments = NSProcessInfo.processInfo.arguments;
  NSUInteger index = [arguments indexOfObject:name];
  return index != NSNotFound && index + 1 < arguments.count ? arguments[index + 1] : nil;
}

@interface BFSWebController : UIViewController <WKScriptMessageHandler>
@property(nonatomic, strong) WKWebView *web;
@property(nonatomic, copy) NSString *ownerNonce;
@property(nonatomic, copy) NSString *fixtureURL;
@property(nonatomic) NSInteger port;
@property(nonatomic) NSUInteger generation;
@property(nonatomic) int listener;
@end

@implementation BFSWebController
- (void)viewDidLoad {
  [super viewDidLoad];
  self.view.backgroundColor = UIColor.whiteColor;
  self.ownerNonce = BFSArgument(@"--bfs-owner-nonce");
  self.port = [BFSArgument(@"--bfs-http-port") integerValue];
  if (self.ownerNonce.length < 24 || self.port < 1024 || self.port > 65535) {
    [NSException raise:@"OwnedFixtureArgumentsMissing" format:@"Explicit local port and owner nonce required"];
  }
  if (![[NSFileManager defaultManager] fileExistsAtPath:BFSPrivateFile(@"webview-ledger.json").path]) {
    BFSWriteJSON(@[], @"webview-ledger.json");
  }
  if (![[NSFileManager defaultManager] fileExistsAtPath:BFSPrivateFile(@"http-events.json").path]) {
    BFSWriteJSON(@[], @"http-events.json");
  }
  self.fixtureURL = [NSString stringWithFormat:@"http://127.0.0.1:%ld/form", (long)self.port];
  WKWebViewConfiguration *configuration = [[WKWebViewConfiguration alloc] init];
  configuration.websiteDataStore = WKWebsiteDataStore.nonPersistentDataStore;
  [configuration.userContentController addScriptMessageHandler:self name:@"bfsSubmit"];
  self.web = [[WKWebView alloc] initWithFrame:CGRectZero configuration:configuration];
  if (@available(iOS 16.4, *)) self.web.inspectable = YES;
  self.web.translatesAutoresizingMaskIntoConstraints = NO;
  self.web.accessibilityIdentifier = @"owned_webview";
  [self.view addSubview:self.web];
  [NSLayoutConstraint activateConstraints:@[
    [self.web.topAnchor constraintEqualToAnchor:self.view.safeAreaLayoutGuide.topAnchor],
    [self.web.bottomAnchor constraintEqualToAnchor:self.view.safeAreaLayoutGuide.bottomAnchor],
    [self.web.leadingAnchor constraintEqualToAnchor:self.view.leadingAnchor],
    [self.web.trailingAnchor constraintEqualToAnchor:self.view.trailingAnchor]
  ]];
  [self startLocalServer];
  [self.web loadRequest:[NSURLRequest requestWithURL:[NSURL URLWithString:self.fixtureURL]
                                        cachePolicy:NSURLRequestReloadIgnoringLocalCacheData timeoutInterval:5]];
}

- (void)userContentController:(WKUserContentController *)controller didReceiveScriptMessage:(WKScriptMessage *)message {
  WKSecurityOrigin *origin = message.frameInfo.securityOrigin;
  NSDictionary *body = [message.body isKindOfClass:NSDictionary.class] ? message.body : nil;
  if (message.webView != self.web || !message.frameInfo.isMainFrame ||
      ![origin.protocol isEqualToString:@"http"] || ![origin.host isEqualToString:@"127.0.0.1"] ||
      origin.port != self.port || ![self.web.URL.absoluteString isEqualToString:self.fixtureURL] ||
      body.count != 2 || ![body[@"query"] isKindOfClass:NSString.class] ||
      ![body[@"detail"] isKindOfClass:NSString.class]) {
    [NSException raise:@"OwnedFixtureBusinessOriginRejected" format:@"Unexpected message origin or shape"];
  }
  NSMutableArray *ledger = BFSReadArray(@"webview-ledger.json");
  NSDictionary *row = @{@"query":body[@"query"], @"detail":body[@"detail"], @"count":@(ledger.count + 1)};
  [ledger addObject:row];
  BFSWriteJSON(ledger, @"webview-ledger.json");
  NSString *json = [[NSString alloc] initWithData:[NSJSONSerialization dataWithJSONObject:row options:0 error:nil]
                                        encoding:NSUTF8StringEncoding];
  [self.web evaluateJavaScript:[NSString stringWithFormat:@"window.bfsFixtureAck(%@)", json]
            completionHandler:^(id value, NSError *error) {
    if (error) [NSException raise:@"OwnedFixtureAckFailed" format:@"%@", error.localizedDescription];
  }];
}

- (void)startLocalServer {
  int listener = socket(AF_INET, SOCK_STREAM, 0), enabled = 1;
  if (listener < 0) [NSException raise:@"OwnedFixtureHTTPFailed" format:@"socket"];
  setsockopt(listener, SOL_SOCKET, SO_REUSEADDR, &enabled, sizeof(enabled));
  struct sockaddr_in address = {0};
  address.sin_family = AF_INET;
  address.sin_port = htons((uint16_t)self.port);
  inet_pton(AF_INET, "127.0.0.1", &address.sin_addr);
  if (bind(listener, (struct sockaddr *)&address, sizeof(address)) || listen(listener, 8)) {
    close(listener);
    [NSException raise:@"OwnedFixtureHTTPFailed" format:@"bind/listen"];
  }
  self.listener = listener;
  dispatch_async(dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
    while (YES) {
      int client = accept(listener, NULL, NULL);
      if (client < 0) break;
      setsockopt(client, SOL_SOCKET, SO_NOSIGPIPE, &enabled, sizeof(enabled));
      struct timeval limit = {.tv_sec = 4, .tv_usec = 0};
      setsockopt(client, SOL_SOCKET, SO_RCVTIMEO, &limit, sizeof(limit));
      setsockopt(client, SOL_SOCKET, SO_SNDTIMEO, &limit, sizeof(limit));
      NSMutableData *request = [NSMutableData data];
      char block[2048];
      while (request.length < 16384) {
        ssize_t count = recv(client, block, sizeof(block), 0);
        if (count <= 0) break;
        [request appendBytes:block length:(NSUInteger)count];
        if ([request rangeOfData:[@"\r\n\r\n" dataUsingEncoding:NSUTF8StringEncoding] options:0
                          range:NSMakeRange(0, request.length)].location != NSNotFound) break;
      }
      NSString *text = [[NSString alloc] initWithData:request encoding:NSUTF8StringEncoding] ?: @"";
      NSArray *lines = [text componentsSeparatedByString:@"\r\n"];
      NSArray *first = [lines.firstObject componentsSeparatedByString:@" "];
      NSString *method = first.count == 3 ? first[0] : @"", *route = first.count == 3 ? first[1] : @"";
      NSMutableDictionary *headers = [NSMutableDictionary dictionary];
      for (NSString *line in lines) {
        NSRange colon = [line rangeOfString:@":"];
        if (colon.location == NSNotFound) continue;
        NSString *key = [[line substringToIndex:colon.location] lowercaseString];
        headers[key] = [[line substringFromIndex:colon.location + 1] stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceCharacterSet];
      }
      __block NSData *body;
      __block NSString *contentType = @"application/json; charset=utf-8";
      __block NSInteger status = 404;
      dispatch_sync(dispatch_get_main_queue(), ^{
        if ([method isEqualToString:@"GET"] && [route isEqualToString:@"/form"]) {
          self.generation++;
          NSString *template = [NSString stringWithContentsOfURL:[NSBundle.mainBundle URLForResource:@"form" withExtension:@"html"]
                                                     encoding:NSUTF8StringEncoding error:nil];
          NSString *html = [template stringByReplacingOccurrencesOfString:@"__BFS_GENERATION__"
                                                               withString:[NSString stringWithFormat:@"%lu", (unsigned long)self.generation]];
          body = [html dataUsingEncoding:NSUTF8StringEncoding];
          contentType = @"text/html; charset=utf-8";
          status = body ? 200 : 500;
        } else if ([method isEqualToString:@"POST"] &&
                   ([route isEqualToString:@"/owner/reload"] || [route isEqualToString:@"/owner/replace-query"])) {
          if (![headers[@"x-bfs-owner"] isEqualToString:self.ownerNonce]) {
            status = 403;
          } else {
            status = 200;
            if ([route isEqualToString:@"/owner/reload"]) [self.web reload];
            else [self.web evaluateJavaScript:@"window.bfsOwnerReplaceQuery()" completionHandler:nil];
          }
          body = [NSJSONSerialization dataWithJSONObject:@{@"scheduled":(status == 200 ? @YES : @NO), @"generationBefore":@(self.generation)} options:0 error:nil];
        }
        NSMutableArray *events = BFSReadArray(@"http-events.json");
        [events addObject:@{@"method":method, @"route":route, @"status":@(status), @"generation":@(self.generation)}];
        BFSWriteJSON(events, @"http-events.json");
      });
      body = body ?: [@"{}" dataUsingEncoding:NSUTF8StringEncoding];
      NSString *response = [NSString stringWithFormat:@"HTTP/1.1 %ld Result\r\nContent-Type: %@\r\nContent-Length: %lu\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n", (long)status, contentType, (unsigned long)body.length];
      NSMutableData *encoded = [[response dataUsingEncoding:NSUTF8StringEncoding] mutableCopy];
      [encoded appendData:body];
      const char *bytes = encoded.bytes;
      NSUInteger written = 0;
      while (written < encoded.length) {
        ssize_t count = send(client, bytes + written, encoded.length - written, 0);
        if (count <= 0) break;
        written += (NSUInteger)count;
      }
      shutdown(client, SHUT_RDWR);
      close(client);
    }
  });
}
@end

@interface BFSWebScene : UIResponder <UIWindowSceneDelegate>
@property(nonatomic, strong) UIWindow *window;
@end
@implementation BFSWebScene
- (void)scene:(UIScene *)scene willConnectToSession:(UISceneSession *)session options:(UISceneConnectionOptions *)options {
  self.window = [[UIWindow alloc] initWithWindowScene:(UIWindowScene *)scene];
  self.window.rootViewController = [[BFSWebController alloc] init];
  [self.window makeKeyAndVisible];
}
@end
@interface BFSWebApp : UIResponder <UIApplicationDelegate>
@end
@implementation BFSWebApp
- (UISceneConfiguration *)application:(UIApplication *)application configurationForConnectingSceneSession:(UISceneSession *)session options:(UISceneConnectionOptions *)options {
  UISceneConfiguration *configuration = [[UISceneConfiguration alloc] initWithName:@"Default Configuration" sessionRole:session.role];
  configuration.delegateClass = BFSWebScene.class;
  return configuration;
}
@end
int main(int argc, char *argv[]) {
  @autoreleasepool { return UIApplicationMain(argc, argv, nil, NSStringFromClass(BFSWebApp.class)); }
}
