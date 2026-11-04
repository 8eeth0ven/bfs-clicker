#import <UIKit/UIKit.h>

// Offline fixture for genuine touch/keyboard/OCR acceptance. This app has no
// network client or test endpoint. The URL scheme changes only its local test
// mode; values and results are produced by UIKeyInput and touches below.
@interface BFSTextCanvas : UIView <UIKeyInput>
@property(nonatomic, copy) NSString *value;
@property(nonatomic, copy) NSString *result;
@property(nonatomic, copy) NSString *mode;
@property(nonatomic) BOOL selectedAll;
@property(nonatomic) NSUInteger queryCount;
@property(nonatomic, strong) UIView *emptyKeyboard;
- (void)resetToMode:(NSString *)mode;
@end

@implementation BFSTextCanvas
- (instancetype)initWithFrame:(CGRect)frame {
    if ((self = [super initWithFrame:frame])) {
        self.backgroundColor = UIColor.whiteColor;
        self.accessibilityElementsHidden = YES;
        self.isAccessibilityElement = NO;
        self.emptyKeyboard = [[UIView alloc] initWithFrame:CGRectZero];
        self.emptyKeyboard.backgroundColor = UIColor.clearColor;
        self.inputAssistantItem.leadingBarButtonGroups = @[];
        self.inputAssistantItem.trailingBarButtonGroups = @[];
        [self resetToMode:@"normal"];
    }
    return self;
}
- (void)resetToMode:(NSString *)mode {
    if (![@[@"normal", @"ignore_input", @"autoupdate_noop"] containsObject:mode]) return;
    [self resignFirstResponder];
    self.mode = mode;
    self.value = @"";
    self.selectedAll = NO;
    self.queryCount = 0;
    self.result = [mode isEqualToString:@"ignore_input"] ? @"RESULT IGNORE"
                : [mode isEqualToString:@"autoupdate_noop"] ? @"RESULT AUTO"
                : @"RESULT NONE";
    [self setNeedsDisplay];
    NSLog(@"BFS_MODE_RESET mode=%@", mode);
}
- (BOOL)canBecomeFirstResponder { return YES; }
// The canvas accepts real key events without a keyboard or blinking caret
// changing pixels outside the two explicitly masked value/result regions.
- (UIView *)inputView { return self.emptyKeyboard; }
- (BOOL)hasText { return self.value.length != 0; }
- (UIKeyboardType)keyboardType { return UIKeyboardTypeASCIICapable; }
- (UITextAutocorrectionType)autocorrectionType { return UITextAutocorrectionTypeNo; }
- (UITextSpellCheckingType)spellCheckingType { return UITextSpellCheckingTypeNo; }
- (UITextSmartQuotesType)smartQuotesType { return UITextSmartQuotesTypeNo; }
- (UITextSmartDashesType)smartDashesType { return UITextSmartDashesTypeNo; }
- (UITextSmartInsertDeleteType)smartInsertDeleteType { return UITextSmartInsertDeleteTypeNo; }
- (NSArray<UIKeyCommand *> *)keyCommands {
    UIKeyCommand *select = [UIKeyCommand keyCommandWithInput:@"a"
                                              modifierFlags:UIKeyModifierCommand
                                                     action:@selector(selectAll:)];
    select.wantsPriorityOverSystemBehavior = YES;
    return @[select];
}
- (void)selectAll:(id)sender { self.selectedAll = YES; }
- (BOOL)canPerformAction:(SEL)action withSender:(id)sender {
    return action == @selector(selectAll:);
}
- (void)updatePaintedInput {
    if ([self.mode isEqualToString:@"autoupdate_noop"]) {
        self.result = [NSString stringWithFormat:@"RESULT %@ AUTO", self.value];
    }
    [self setNeedsDisplay];
}
- (void)insertText:(NSString *)text {
    if ([self.mode isEqualToString:@"ignore_input"]) return;
    if (self.selectedAll) { self.value = @""; self.selectedAll = NO; }
    // A bounded real UI text buffer, not a precomputed set of accepted samples.
    NSString *next = [self.value stringByAppendingString:text];
    if (next.length <= 32 && [next rangeOfCharacterFromSet:
        [[NSCharacterSet alphanumericCharacterSet] invertedSet]].location == NSNotFound) {
        self.value = next;
    }
    [self updatePaintedInput];
}
- (void)deleteBackward {
    if ([self.mode isEqualToString:@"ignore_input"]) return;
    if (self.selectedAll) self.value = @"";
    else if (self.value.length) {
        NSRange last = [self.value rangeOfComposedCharacterSequenceAtIndex:self.value.length - 1];
        self.value = [self.value substringToIndex:last.location];
    }
    self.selectedAll = NO;
    [self updatePaintedInput];
}
- (void)drawRect:(CGRect)rect {
    CGFloat w = self.bounds.size.width, h = self.bounds.size.height;
    NSDictionary *attrs = @{NSFontAttributeName:[UIFont boldSystemFontOfSize:30],
                            NSForegroundColorAttributeName:UIColor.blackColor};
    [@"Query" drawAtPoint:CGPointMake(w * .12, h * .20) withAttributes:attrs];
    [self.value drawAtPoint:CGPointMake(w * .12, h * .28) withAttributes:attrs];
    [@"Search" drawAtPoint:CGPointMake(w * .12, h * .42) withAttributes:attrs];
    [self.result drawAtPoint:CGPointMake(w * .12, h * .62) withAttributes:attrs];
}
- (void)touchesEnded:(NSSet<UITouch *> *)touches withEvent:(UIEvent *)event {
    CGPoint point = [[touches anyObject] locationInView:self];
    CGFloat y = point.y / self.bounds.size.height;
    if (y >= .19 && y < .36) { [self becomeFirstResponder]; return; }
    if (y >= .41 && y < .49) {
        if (![self.mode isEqualToString:@"autoupdate_noop"]) {
            self.queryCount += 1;
            self.result = [NSString stringWithFormat:@"RESULT %@ %lu", self.value,
                           (unsigned long)self.queryCount];
            [self setNeedsDisplay];
        }
    }
}
@end

@interface BFSDemoController : UIViewController @end
@implementation BFSDemoController
- (void)loadView { self.view = [[BFSTextCanvas alloc] initWithFrame:UIScreen.mainScreen.bounds]; }
- (BOOL)prefersStatusBarHidden { return YES; }
@end

// UIKit may deliver a URL through a scene or the application delegate. Both
// paths use the same local mode-only handler; input values never come from URL.
static NSURL *BFSPendingModeURL;
static NSString *BFSLastAppliedModeURL;
static BOOL BFSApplyModeURL(NSURL *url, NSString *source, UIWindow *preferredWindow) {
    if (!url) return NO;
    NSLog(@"BFS_MODE_RECEIVED source=%@ url=%@", source, url.absoluteString);
    if (![url.scheme.lowercaseString isEqualToString:@"bfsmcpvisualtext"] ||
        ![url.host.lowercaseString isEqualToString:@"mode"]) return NO;
    NSString *mode = [url.path stringByTrimmingCharactersInSet:
        [NSCharacterSet characterSetWithCharactersInString:@"/"]];
    if (![@[@"normal", @"ignore_input", @"autoupdate_noop"] containsObject:mode]) return NO;
    if ([BFSLastAppliedModeURL isEqualToString:url.absoluteString]) {
        NSLog(@"BFS_MODE_DUPLICATE source=%@ mode=%@", source, mode);
        return YES;
    }
    NSMutableArray<UIWindow *> *windows = [NSMutableArray array];
    if (preferredWindow) [windows addObject:preferredWindow];
    for (UIScene *scene in UIApplication.sharedApplication.connectedScenes) {
        if ([scene isKindOfClass:UIWindowScene.class]) {
            for (UIWindow *window in ((UIWindowScene *)scene).windows) {
                if (![windows containsObject:window]) [windows addObject:window];
            }
        }
    }
    // The fallback also works when a simulator chooses the legacy application
    // URL callback even though the app's visible window was created by a scene.
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
    for (UIWindow *window in UIApplication.sharedApplication.windows) {
        if (![windows containsObject:window]) [windows addObject:window];
    }
#pragma clang diagnostic pop
    for (UIWindow *window in windows) {
        UIView *view = window.rootViewController.view;
        if ([view isKindOfClass:BFSTextCanvas.class]) {
            [(BFSTextCanvas *)view resetToMode:mode];
            BFSLastAppliedModeURL = url.absoluteString;
            BFSPendingModeURL = nil;
            NSLog(@"BFS_MODE_APPLIED source=%@ mode=%@", source, mode);
            return YES;
        }
    }
    BFSPendingModeURL = url;
    NSLog(@"BFS_MODE_DEFERRED source=%@ mode=%@ windows=%lu", source, mode,
          (unsigned long)windows.count);
    return YES;
}

@interface BFSDemoSceneDelegate : UIResponder <UIWindowSceneDelegate>
@property(nonatomic, strong) UIWindow *window;
@end
@implementation BFSDemoSceneDelegate
- (void)applyURL:(NSURL *)url {
    BFSApplyModeURL(url, @"scene.openURLContexts", self.window);
}
- (void)scene:(UIScene *)scene willConnectToSession:(UISceneSession *)session options:(UISceneConnectionOptions *)options {
    if (![scene isKindOfClass:UIWindowScene.class]) return;
    self.window = [[UIWindow alloc] initWithWindowScene:(UIWindowScene *)scene];
    self.window.rootViewController = [BFSDemoController new];
    [self.window makeKeyAndVisible];
    for (UIOpenURLContext *context in options.URLContexts) [self applyURL:context.URL];
    if (BFSPendingModeURL) BFSApplyModeURL(BFSPendingModeURL, @"scene.connected.pending", self.window);
}
- (void)scene:(UIScene *)scene openURLContexts:(NSSet<UIOpenURLContext *> *)contexts {
    for (UIOpenURLContext *context in contexts) [self applyURL:context.URL];
}
- (void)sceneDidBecomeActive:(UIScene *)scene {
    if (BFSPendingModeURL) BFSApplyModeURL(BFSPendingModeURL, @"scene.active.pending", self.window);
}
@end

@interface BFSDemoDelegate : UIResponder <UIApplicationDelegate> @end
@implementation BFSDemoDelegate
- (BOOL)application:(UIApplication *)application didFinishLaunchingWithOptions:(NSDictionary *)options {
    NSURL *url = options[UIApplicationLaunchOptionsURLKey];
    if (url) BFSApplyModeURL(url, @"application.launch", nil);
    return YES;
}
- (BOOL)application:(UIApplication *)application openURL:(NSURL *)url options:(NSDictionary<UIApplicationOpenURLOptionsKey,id> *)options {
    return BFSApplyModeURL(url, @"application.openURL", nil);
}
- (void)applicationDidBecomeActive:(UIApplication *)application {
    if (BFSPendingModeURL) BFSApplyModeURL(BFSPendingModeURL, @"application.active.pending", nil);
}
- (UISceneConfiguration *)application:(UIApplication *)application configurationForConnectingSceneSession:(UISceneSession *)session options:(UISceneConnectionOptions *)options {
    UISceneConfiguration *config = [[UISceneConfiguration alloc] initWithName:@"Default Configuration" sessionRole:session.role];
    config.delegateClass = BFSDemoSceneDelegate.class;
    return config;
}
@end
int main(int argc, char *argv[]) {
    @autoreleasepool { return UIApplicationMain(argc, argv, nil, NSStringFromClass(BFSDemoDelegate.class)); }
}
